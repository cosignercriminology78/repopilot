import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { runPipeline } from '../src/pipeline.js';
import type { Agent } from '../src/agent.js';
import type { TestResult } from '../src/types.js';

const result = (status: TestResult['status']): TestResult => ({ status, exitCode: status === 'passed' ? 0 : 1, output: status, durationMs: 1 });
const base = new Map([['.repopilot/policy.json', JSON.stringify({ rules: [{ id: 'bad', forbiddenText: 'BAD', extensions: ['.ts'], message: 'bad source' }] })], ['src/a.ts', 'GOOD']]);
const head = new Map(base); head.set('src/a.ts', 'BAD');
const input = { base, head, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const config = configSchema.parse({ repository: 'example/project', agent: { enabled: true, repair: true } });
async function store() {
  await mkdir('.cache/tests', { recursive: true });
  return new Store(await mkdtemp(resolve('.cache/tests/run-')));
}
function agent(): Agent { return { review: async () => ({ findings: [], changes: [], summary: '' }),
  repair: async () => ({ findings: [], changes: [{ path: 'src/a.ts', content: 'GOOD' }], summary: 'fixed' }) }; }
test('static violation is repaired only after independent verification', async () => {
  const saved = await store(); let calls = 0;
  const report = await runPipeline(input, config, saved, { run: async () => { calls++; return result('passed'); } }, agent());
  assert.equal(report.status, 'verified'); assert.equal(calls, 3); assert.equal(report.changes.length, 1);
  const again = await runPipeline(input, config, saved, { run: async () => { throw new Error('must dedupe'); } }, agent());
  assert.equal(again.id, report.id); assert.equal(again.status, 'verified');
});
test('missing tests never count as passed and do not trigger repair', async () => {
  const report = await runPipeline(input, config, await store());
  assert.equal(report.status, 'needs_attention'); assert.equal(report.tests.head.status, 'not_run'); assert.equal(report.attempts, 0);
});
test('environment failure blocks automatic repair', async () => {
  const report = await runPipeline(input, config, await store(), { run: async () => result('error') }, agent());
  assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 0);
});
test('historical test failure blocks automatic repair', async () => {
  const report = await runPipeline(input, config, await store(), { run: async () => result('failed') }, agent());
  assert.equal(report.attempts, 0); assert.match(report.notes.join(), /Base tests already fail/);
});
test('candidate policy edits require review and cannot be auto-repaired', async () => {
  const candidate = new Map(head); candidate.delete('.repopilot/policy.json');
  const report = await runPipeline({ ...input, head: candidate }, config, await store(), { run: async () => result('passed') }, agent());
  assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 0);
});
test('invalid patches terminate after the configured attempt limit', async () => {
  const badAgent = agent(); badAgent.repair = async () => ({ findings: [], changes: [{ path: 'package.json', content: '{}' }], summary: '' });
  const report = await runPipeline(input, config, await store(), { run: async () => result('passed') }, badAgent);
  assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 2); assert.equal(report.changes.length, 0);
});
test('controller lock prevents concurrent writers and can be released', async () => {
  const s = await store(), release = await s.acquire();
  await assert.rejects(s.acquire(), /lock exists/); await release(); await (await s.acquire())();
});
