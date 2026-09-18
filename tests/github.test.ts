import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';
import type { Report } from '../src/types.js';

const report = { repository: 'owner/repo', id: 'a'.repeat(24), pr: 1, status: 'verified', head: 'a'.repeat(40), base: 'b'.repeat(40),
  changes: [{ path: 'src/a.ts', content: 'fixed' }], tests: { repaired: { status: 'passed' } } } as Report;
test('stale source prevents all GitHub mutations', async () => {
  const client = new GitHub('owner/repo', 'test-placeholder'); const methods: string[] = [];
  client.request = async <T>(_path: string, method = 'GET'): Promise<T> => {
    methods.push(method); return { state: 'open', head: { sha: 'c'.repeat(40), repo: { full_name: 'owner/repo' } }, base: { sha: report.base } } as T;
  };
  assert.equal(await client.publish(report), undefined); assert.deepEqual(methods, ['GET']);
});
test('unverified report cannot create a branch', async () => {
  const client = new GitHub('owner/repo', 'test-placeholder');
  await assert.rejects(client.publish({ ...report, status: 'needs_attention' }), /Only verified/);
});
test('fork PR cannot publish into upstream automatically', async () => {
  const client = new GitHub('owner/repo', 'test-placeholder');
  client.request = async <T>(): Promise<T> => ({ state: 'open', head: { sha: report.head, repo: { full_name: 'other/repo' } }, base: { sha: report.base } } as T);
  assert.equal(await client.publish(report), undefined);
});
