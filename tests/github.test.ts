import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../src/adapters/github/client.js';
import { finishReport } from '../src/application/publication.js';
import { configSchema } from '../src/domain/config.js';
import { RetryableError } from '../src/shared/control.js';
import { pr, store, verifiedReport } from './helpers.js';
test('stale commits, descriptions, drafts and forks prevent all GitHub mutations', async () => {
  for (const candidate of [
    { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } }, { ...pr, body: 'edited' },
    { ...pr, draft: true }, { ...pr, head: { ...pr.head, repo: { full_name: 'other/repo' } } }
  ]) {
    const client = new GitHub('owner/repo', 'test-placeholder'), methods: string[] = [];
    client.request = async <T>(_path: string, method = 'GET'): Promise<T> => { methods.push(method); return candidate as T; };
    assert.equal(await client.publish(verifiedReport()), undefined); assert.deepEqual(methods, ['GET']);
  }
});
test('publication failures persist bounded retry attempts and permanent failures stop', async () => {
  const config = configSchema.parse({ repository: 'owner/repo', publish: true, retry: { baseDelayMs: 0, maxTaskExecutions: 2 } });
  const saved = await store(), report = verifiedReport(); let calls = 0;
  const github = { current: async () => pr, publish: async () => { calls++; throw new RetryableError('temporary'); } };
  await finishReport(report, config, saved, github);
  await finishReport(report, config, saved, github);
  await finishReport(report, config, saved, github);
  assert.equal(calls, 2); assert.equal((await saved.read(report.id))?.publication?.attempts, 2);
  const permanent = verifiedReport(); github.publish = async () => { calls++; throw new Error('denied'); };
  await finishReport(permanent, config, saved, github);
  await finishReport(permanent, config, saved, github);
  assert.equal(calls, 3); assert.equal(permanent.publication?.retryable, false);
});
test('unverified or unstructured evidence cannot create a branch', async () => {
  const client = new GitHub('owner/repo', 'test-placeholder');
  await assert.rejects(client.publish({ ...verifiedReport(), status: 'needs_attention' }), /Only verified/);
  const report = verifiedReport(); report.tests.repaired!.structured = false;
  await assert.rejects(client.publish(report), /Only verified/);
});
test('GitHub GET retries transient failures; writes are not blindly repeated and rate windows are respected', async () => {
  let calls = 0;
  const client = new GitHub('owner/repo', 'test-placeholder', {
    retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
    transport: async () => { calls++; return new Response(JSON.stringify(pr), { status: calls === 1 ? 503 : 200 }); }
  });
  assert.equal((await client.pull(1)).number, 1); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(client.request('pulls', 'POST', {}), RetryableError); assert.equal(calls, 1);
  const limited = new GitHub('owner/repo', 'test-placeholder', {
    retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
    transport: async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }); }
  });
  calls = 0;
  await assert.rejects(limited.pull(1), (error: unknown) => error instanceof RetryableError && error.retryAfterMs === 60000);
  assert.equal(calls, 1);
});
test('publication preserves executable modes and attaches evidence', async () => {
  const client = new GitHub('owner/repo', 'test-placeholder'), writes: { path: string; body: any }[] = [];
  client.request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method !== 'GET') writes.push({ path, body });
    let value: unknown;
    if (path === 'pulls/1') value = pr;
    else if (path.startsWith('pulls?')) value = [];
    else if (path === 'git/commits/' + pr.head.sha) value = { tree: { sha: 'source-tree' } };
    else if (path === 'git/trees/source-tree?recursive=1') value = { truncated: false, tree: [{ path: 'src/a.ts', mode: '100755', type: 'blob' }] };
    else if (path === 'git/trees') value = { sha: 'fixed-tree' };
    else if (path === 'git/commits') value = { sha: 'fixed-commit' };
    else if (path.startsWith('git/ref/')) throw new Error('HTTP 404');
    else if (path === 'git/refs') value = {};
    else if (path === 'pulls') value = { html_url: 'https://github.com/owner/repo/pull/2' };
    else throw new Error('Unexpected request: ' + path);
    return value as T;
  };
  assert.match((await client.publish(verifiedReport()))!, /pull\/2$/);
  assert.equal(writes.find(w => w.path === 'git/trees')?.body.tree[0].mode, '100755');
  assert.match(writes.find(w => w.path === 'pulls')?.body.body, /Runner evidence/);
});
