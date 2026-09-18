import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../src/application/pipeline.js';
import { fixIssue } from '../src/application/issue.js';
import { GitHub } from '../src/adapters/github/client.js';
import { configSchema } from '../src/domain/config.js';
import { descriptionHash, pipelineId } from '../src/domain/identity.js';
import { replayInput } from '../src/application/tasks.js';
import { agent, result, store, testCase, verifiedReport } from './helpers.js';
import type { Runner } from '../src/ports/runner.js';
import type { Issue, Report } from '../src/domain/types.js';

const source = { number: 12, title: 'Reject negative quantities', body: 'Negative quantities must produce a validation error.', branch: 'main' };
const description = source.title + '\n' + source.body;
const base = new Map([['src/a.ts', 'BROKEN']]);
const input = { base, head: base, baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40), description, issue: source, repoPath: '/fixture' };
const config = configSchema.parse({ repository: 'owner/repo', agent: { enabled: true, repair: true }, retry: { baseDelayMs: 0 } });
const runner: Runner = { run: async files => {
  const cases = [testCase()];
  if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js', files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed'));
  return result(cases.some(c => c.status === 'failed') ? 'failed' : 'passed', cases);
} };
function model() {
  const value = agent(), plan = value.plan;
  value.plan = async (...args) => { const answer = await plan(...args); answer.scenarios.forEach(s => { s.requirementQuote = source.body; }); return answer; };
  return value;
}

test('Issue reproduction freezes new tests and verifies repair on a single pinned snapshot', async () => {
  const report = await runPipeline(input, config, await store(), runner, model());
  assert.equal(report.status, 'verified'); assert.equal(report.testStability?.status, 'stable');
  assert.equal(report.issue?.number, 12); assert.equal(report.pr, undefined);
  assert.equal(report.tests.base.status, 'passed'); assert.equal(report.tests.repaired?.status, 'passed');
  assert.equal(report.changes.length, 2);
  assert.equal(pipelineId(replayInput({ ...report, status: 'cancelled' }, config, 'resume'), config), report.id);
  assert.notEqual(report.id, pipelineId({ ...input, issue: undefined }, config));
});

test('unreproduced, uncited and unstable Issues never request a repair', async () => {
  const green: Runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
  const unreproduced = await runPipeline(input, config, await store(), green, model());
  assert.equal(unreproduced.status, 'needs_attention'); assert.equal(unreproduced.attempts, 0);
  const uncited = await runPipeline(input, config, await store(), runner, agent());
  assert.equal(uncited.status, 'error'); assert.equal(uncited.attempts, 0);
  const flaky: Runner = { run: async (files, phase) => phase === 'repeat-head' ? green.run(files, phase) : runner.run(files, phase) };
  const unstable = await runPipeline(input, config, await store(), flaky, model());
  assert.equal(unstable.testStability?.status, 'unstable'); assert.equal(unstable.attempts, 0);
  const originalFlaky: Runner = { run: async (files, phase) => phase === 'head' ? result('failed') : runner.run(files, phase) };
  const original = await runPipeline(input, config, await store(), originalFlaky, model());
  assert.equal(original.status, 'needs_attention'); assert.equal(original.plan, undefined); assert.equal(original.attempts, 0);
});

function issueReport(): Report {
  return { ...verifiedReport(), pr: undefined, issue: source, base: input.baseSha, head: input.headSha, descriptionHash: descriptionHash(undefined, description) };
}
test('Issue closure, edits, PR-number confusion and moved branch stop publication before writes', async () => {
  for (const [issue, sha] of [
    [{ ...source, state: 'closed' }, input.headSha], [{ ...source, state: 'open', body: 'edited' }, input.headSha],
    [{ ...source, state: 'open', pull_request: {} }, input.headSha], [{ ...source, state: 'open' }, 'b'.repeat(40)]
  ] as const) {
    const client = new GitHub('owner/repo', 'fixture');
    client.request = async <T>(path: string, method = 'GET'): Promise<T> => {
      assert.equal(method, 'GET'); return (path.startsWith('issues/') ? issue : { object: { type: 'commit', sha } }) as T;
    };
    assert.equal(await client.publish(issueReport()), undefined);
  }
});

test('verified Issue repair opens a draft PR against the target branch and links the Issue', async () => {
  const client = new GitHub('owner/repo', 'fixture'), writes: { path: string; body: any }[] = [];
  client.request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method !== 'GET') writes.push({ path, body });
    let value: unknown;
    if (path.startsWith('issues/')) value = { ...source, state: 'open' };
    else if (path === 'git/ref/heads/main') value = { object: { type: 'commit', sha: input.headSha } };
    else if (path.startsWith('pulls?')) value = [];
    else if (path === 'git/commits/' + input.headSha) value = { tree: { sha: 'source-tree' } };
    else if (path === 'git/trees/source-tree?recursive=1') value = { truncated: false, tree: [] };
    else if (path === 'git/trees') value = { sha: 'fixed-tree' };
    else if (path === 'git/commits') value = { sha: 'fixed-commit' };
    else if (path.startsWith('git/ref/')) throw new Error('HTTP 404');
    else if (path === 'git/refs') value = {};
    else if (path === 'pulls') value = { html_url: 'https://github.com/owner/repo/pull/99' };
    else throw new Error('Unexpected request: ' + path);
    return value as T;
  };
  assert.match((await client.publish(issueReport()))!, /99$/);
  const body = writes.find(w => w.path === 'pulls')!.body;
  assert.equal(body.base, 'main'); assert.equal(body.draft, true); assert.match(body.head, /^autofix\/issue-12\//);
  assert.match(body.body, /^Fixes #12/);
});

test('fix Issue orchestration fetches exact target SHA and respects publish=false', async () => {
  const saved = await store(); let published = false;
  const github = { issue: async (): Promise<Issue> => ({ ...source, state: 'open' }), target: async () => ({ branch: 'main', sha: input.headSha }),
    listPulls: async () => [], pull: async () => { throw new Error('No PR lookup'); }, current: async () => ({ ...source, state: 'open' }),
    publish: async () => { published = true; return ''; } };
  const repository = { prepare: async () => {}, fetch: async (_path: string, _repo: string, a: string, b: string) => { assert.equal(a, input.headSha); assert.equal(b, a); },
    snapshot: async () => base, resolveCommit: async () => input.headSha };
  const report = await fixIssue(12, undefined, { config, store: saved, runner, agent: model(), github, repository, signal: new AbortController().signal });
  assert.equal(report.status, 'verified'); assert.equal(published, false);
  await assert.rejects(fixIssue(-1, undefined, { config, store: saved, runner, agent: model(), github, repository, signal: new AbortController().signal }), /positive/);
});
