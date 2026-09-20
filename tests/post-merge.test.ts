import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGoals } from '../src/application/evaluation.js';
import { trackPostMerge } from '../src/application/post-merge.js';
import type { AutomationDependencies } from '../src/application/automation.js';
import { executeGoals } from '../src/cli/commands/goals.js';
import { configSchema } from '../src/domain/config.js';
import type { GoalState } from '../src/domain/iteration.js';
import type { IterationStore } from '../src/ports/iteration.js';
import { pr } from './helpers.js';

function goal(id = 'a'.repeat(24)): GoalState {
  return { schemaVersion: 1, id, repository: 'owner/repo', configHash: 'config',
    spec: { title: 'Implement benchmark behavior', objective: 'Implement benchmark behavior safely.', mode: 'feature',
      acceptance: [{ id: 'works', text: 'The benchmark behavior works correctly.' }], allowedPaths: ['src'],
      evaluation: { suite: 'core-suite', case: 'feature-case', profile: 'codex-default' } },
    branch: 'main', sha: pr.base.sha, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    status: 'published', steps: [{ id: 'works', title: 'Implement benchmark behavior', acceptanceIds: ['works'], dependsOn: [] }],
    completed: ['works'], changes: [], reports: [], rounds: 2, calls: 3, tokens: 100, elapsedMs: 500,
    notes: [], publication: 'b'.repeat(24), pullRequestUrl: 'https://github.com/owner/repo/pull/1' };
}

function memoryStore(state: GoalState): IterationStore {
  return { read: async id => id === state.id ? state : undefined, save: async next => { Object.assign(state, next); },
    list: async () => [state], pause: async () => {}, paused: async () => false, unpause: async () => {},
    remember: async () => {}, experiences: async () => [] };
}

test('post-merge tracking waits for merge evidence, verifies the merge commit and records regressions', async () => {
  const state = goal(), goals = memoryStore(state), merged = 'c'.repeat(40);
  let pull = { ...pr, head: { ...pr.head, ref: `autofix/goal-${state.id}/${state.publication}` },
    state: 'open', merged_at: null as string | null, merge_commit_sha: null as string | null };
  let checks = [{ name: 'tests', status: 'completed', conclusion: 'success' as string | null }], issueState = 'open';
  const github = { target: async () => ({ branch: 'main', sha: pr.base.sha }), issue: async () => ({ number: 7, title: 'Issue title', body: '', state: issueState }),
    issues: async () => [], feedback: async () => { throw new Error('Unexpected feedback'); }, updatePull: async () => undefined,
    recoverPull: async () => undefined, propose: async () => '', outcome: async () => ({ pr: pull, checks }) };
  const deps = { repository: 'owner/repo', requiredChecks: ['tests'], requireIssueClosed: true, goals, github };
  assert.equal((await trackPostMerge(state.id, deps))?.status, 'waiting_for_merge');

  state.spec.issue = 7;
  pull = { ...pull, state: 'closed', merged_at: '2026-01-02T00:00:00Z', merge_commit_sha: merged };
  checks = [{ name: 'tests', status: 'in_progress', conclusion: null }];
  assert.equal((await trackPostMerge(state.id, deps))?.status, 'observing');

  checks = [{ name: 'tests', status: 'completed', conclusion: 'failure' }];
  assert.equal((await trackPostMerge(state.id, deps))?.status, 'regressed');
  assert.match(state.notes.at(-1)!, /Post-merge regression/);
  const notes = state.notes.length;
  await trackPostMerge(state.id, deps);
  assert.equal(state.notes.length, notes, 'repeated polling must not duplicate regression notes');

  checks = [{ name: 'tests', status: 'completed', conclusion: 'success' }]; issueState = 'closed';
  const healthy = await trackPostMerge(state.id, deps);
  assert.equal(healthy?.status, 'healthy'); assert.equal(healthy?.mergeSha, merged);
});

test('evaluation reports deterministic evidence by suite and profile', () => {
  const healthy = goal(), failed = goal('b'.repeat(24));
  healthy.postMerge = { pull: 1, status: 'healthy', mergeSha: 'c'.repeat(40), checkedAt: '2026-01-02T00:00:00Z', checks: [], reasons: [] };
  failed.spec.evaluation = { suite: 'core-suite', case: 'bug-case', profile: 'codex-default' };
  failed.status = 'needs_attention'; failed.completed = [];
  const report = evaluateGoals([failed, healthy], 'core-suite');
  assert.equal(report.records.length, 2); assert.equal(report.profiles[0]?.verificationRate, 0.5);
  assert.equal(report.profiles[0]?.postMergePassRate, 1); assert.equal(report.profiles[0]?.averageCalls, 3);
  assert.equal(report.digest, evaluateGoals([healthy, failed], 'core-suite').digest);
  assert.deepEqual(report.duplicateKeys, []); assert.deepEqual(report.inconsistentCases, []);
});

test('iteration switches a merged goal from PR maintenance to post-merge tracking', async () => {
  const state = goal(), goals = memoryStore(state), merge = 'd'.repeat(40);
  const config = configSchema.parse({ repository: state.repository, iteration: { postMerge: { requiredChecks: ['tests'] } } });
  const owned = { ...pr, head: { ...pr.head, ref: `autofix/goal-${state.id}/${state.publication}` }, state: 'closed',
    merged_at: '2026-01-02T00:00:00Z', merge_commit_sha: merge };
  const deps: AutomationDependencies = { config, goals, signal: new AbortController().signal,
    store: {} as AutomationDependencies['store'], repository: {} as AutomationDependencies['repository'],
    github: { listPulls: async () => [], pull: async () => owned, current: async () => undefined, publish: async () => undefined,
      target: async () => ({ branch: 'main', sha: pr.base.sha }), issue: async () => { throw new Error('Unexpected Issue read'); },
      issues: async () => [], feedback: async () => { throw new Error('Unexpected feedback'); }, updatePull: async () => undefined,
      recoverPull: async () => undefined, propose: async () => '',
      outcome: async () => ({ pr: owned, checks: [{ name: 'tests', status: 'completed', conclusion: 'success' }] }) } };
  const output: string[] = [];
  assert.equal(await executeGoals('iterate', undefined, undefined, { once: true }, deps,
    { write: value => output.push(value), error: value => assert.fail(value) }), 0);
  assert.equal(state.postMerge?.status, 'healthy');
  assert.equal(JSON.parse(output[0]!).mergeSha, merge);
});
