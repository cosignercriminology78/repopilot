import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { testId, failureFingerprint } from '../src/test-results.js';
import type { Answer, Agent } from '../src/agent.js';
import type { TestResult, TestCase, Report, PullRequest } from '../src/types.js';
import { descriptionHash } from '../src/pipeline.js';
export const answer = (changes: Answer['changes'] = []): Answer => ({ findings: [], changes, scenarios: [], summary: 'fixture' });
export const testCase = (file = 'test/original.test.js', status: TestCase['status'] = 'passed', failure = 'assert expected 1'): TestCase =>
  ({ id: testId(file, 'works'), file, name: 'works', status, durationMs: 1,
    ...(status === 'failed' ? { failure, fingerprint: failureFingerprint(failure) } : {}) });
export const result = (status: TestResult['status'] = 'passed', cases = [testCase(undefined, status === 'failed' ? 'failed' : 'passed')]): TestResult =>
  ({ status, exitCode: status === 'passed' ? 0 : 1, output: status, durationMs: 1, cases, structured: true });
export async function store() { await mkdir('.cache/tests', { recursive: true }); return new Store(await mkdtemp(resolve('.cache/tests/run-'))); }
export function agent(): Agent { return {
  review: async () => answer(),
  plan: async () => ({ ...answer([{ path: 'test/generated.test.js', content: 'test("works", () => {});' }]),
    scenarios: [{ name: 'works', requirement: 'PR intended behavior', testFile: 'test/generated.test.js' }] }),
  repair: async () => answer([{ path: 'src/a.ts', content: 'GOOD' }])
}; }
export const pr: PullRequest = { number: 1, title: 'Fix behavior', body: 'Expected behavior', state: 'open', draft: false,
  head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'owner/repo' } },
  base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'owner/repo' } } };
export function verifiedReport(): Report {
  return { schemaVersion: 2, repository: 'owner/repo', id: 'a'.repeat(24), pr: 1, status: 'verified',
    head: pr.head.sha, base: pr.base.sha, descriptionHash: descriptionHash(pr),
    changes: [{ path: 'src/a.ts', content: 'fixed' }], tests: { base: result(), head: result('failed'), repaired: result() },
    findings: [], historical: [], suppressed: [], semantic: 'completed', evidence: [], repairs: [], attempts: 1, notes: [],
    createdAt: new Date().toISOString(), executions: 1, retryable: false };
}
