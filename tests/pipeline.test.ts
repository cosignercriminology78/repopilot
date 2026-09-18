import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';
import { result, testCase, store, agent, answer } from './helpers.js';
import { StaleTaskError, RetryableError } from '../src/control.js';
import type { Runner } from '../src/runner.js';
const base = new Map([['.repopilot/policy.json', JSON.stringify({ rules: [{ id: 'bad', forbiddenText: 'BAD', extensions: ['.ts'], message: 'bad source' }] })], ['src/a.ts', 'GOOD']]);
const head = new Map(base); head.set('src/a.ts', 'BAD');
const input = { base, head, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const config = configSchema.parse({ repository: 'example/project', agent: { enabled: true, repair: true } });
const runner: Runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
test('static violation repairs after planning, verification and deduplication', async () => {
  const saved = await store();
  const report = await runPipeline(input, config, saved, runner, agent());
  assert.equal(report.status, 'verified'); assert.equal(report.evidence.length, 5); assert.equal(report.changes.length, 2);
  assert.ok(report.plan); assert.equal(report.repairs[0]?.accepted, true);
  const again = await runPipeline(input, config, saved, { run: async () => { throw new Error('must dedupe'); } }, agent());
  assert.equal(again.id, report.id); assert.equal(again.status, 'verified');
});
test('missing tests and environment failures do not trigger repair', async () => {
  const missing = await runPipeline(input, config, await store());
  assert.equal(missing.status, 'needs_attention'); assert.equal(missing.attempts, 0);
  const error = await runPipeline(input, config, await store(), { run: async () => result('error') }, agent());
  assert.equal(error.status, 'needs_attention'); assert.equal(error.attempts, 0);
});
test('historical test failure blocks automatic repair', async () => {
  const report = await runPipeline(input, config, await store(), { run: async () => result('failed') }, agent());
  assert.equal(report.attempts, 0); assert.match(report.notes.join(), /Base tests already fail/);
});
test('policy edits require review', async () => {
  const candidate = new Map(head); candidate.delete('.repopilot/policy.json');
  const report = await runPipeline({ ...input, head: candidate }, config, await store(), runner, agent());
  assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 0);
});
test('invalid patches terminate after configured attempts', async () => {
  const bad = agent(); bad.repair = async () => answer([{ path: 'package.json', content: '{}' }]);
  const report = await runPipeline(input, config, await store(), runner, bad);
  assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 2); assert.equal(report.changes.length, 0);
});
test('new tests execute even when original suite passes; stable regression is repaired', async () => {
  const generated: Runner = { run: async files => {
    const cases = [testCase()];
    if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js', files.get('src/a.ts') === 'BAD' ? 'failed' : 'passed'));
    return result(cases.some(c => c.status === 'failed') ? 'failed' : 'passed', cases);
  } };
  const report = await runPipeline(input, config, await store(), generated, agent());
  assert.equal(report.status, 'verified'); assert.equal(report.evidence.find(e => e.phase === 'repeat-head')?.result.status, 'failed');
});
test('undiscovered generated tests fail closed', async () => {
  const report = await runPipeline(input, config, await store(), { run: async () => result() }, agent());
  assert.equal(report.status, 'error'); assert.equal(report.attempts, 0); assert.match(report.notes.join(), /not fully executed/);
});
test('changing failure fingerprint blocks repair', async () => {
  const flaky: Runner = { run: async (files, label) => {
    const fail = files.has('test/generated.test.js') && files.get('src/a.ts') === 'BAD';
    return result(fail ? 'failed' : 'passed', [testCase(), ...(files.has('test/generated.test.js')
      ? [testCase('test/generated.test.js', fail ? 'failed' : 'passed', label === 'repeat-head' ? 'different failure' : 'assert expected 1')] : [])]);
  } };
  const report = await runPipeline(input, config, await store(), flaky, agent());
  assert.equal(report.attempts, 0); assert.match(report.notes.join(), /fingerprints changed/);
});
test('repair cannot remove generated test discovery or edit frozen tests', async () => {
  const missing: Runner = { run: async (files, label) => label === 'repair' ? result() : runner.run(files, label) };
  const report = await runPipeline(input, config, await store(), missing, agent());
  assert.equal(report.status, 'needs_attention'); assert.match(report.notes.join(), /same test identities/);
  const bad = agent(); bad.repair = async () => answer([{ path: 'test/generated.test.js', content: '' }]);
  const frozen = await runPipeline(input, config, await store(), runner, bad);
  assert.equal(frozen.status, 'needs_attention'); assert.match(frozen.notes.join(), /frozen tests/);
});
test('description edits produce a new task without changing commits', async () => {
  const saved = await store();
  const a = await runPipeline({ ...input, description: 'first' }, config, saved);
  const b = await runPipeline({ ...input, description: 'second' }, config, saved);
  assert.notEqual(a.id, b.id); assert.notEqual(a.descriptionHash, b.descriptionHash);
});
test('stale cancellation interrupts active runner and persists state', async () => {
  const controller = new AbortController();
  const blocked: Runner = { run: async (_files, _label, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    controller.abort(new StaleTaskError());
  }) };
  const report = await runPipeline(input, config, await store(), blocked, undefined, controller.signal);
  assert.equal(report.status, 'stale'); assert.equal(report.attempts, 0);
});
test('retryable task errors have bounded durable executions', async () => {
  const saved = await store(), retryConfig = configSchema.parse({ ...config, retry: { ...config.retry, baseDelayMs: 0, maxTaskExecutions: 2 } });
  let calls = 0; const bad = agent(); bad.review = async () => { calls++; throw new RetryableError('temporary'); };
  const one = await runPipeline(input, retryConfig, saved, runner, bad);
  const two = await runPipeline(input, retryConfig, saved, runner, bad);
  const three = await runPipeline(input, retryConfig, saved, runner, bad);
  assert.equal(one.executions, 1); assert.equal(two.executions, 2); assert.equal(three.executions, 2); assert.equal(calls, 2);
});
test('controller lock prevents concurrent writers and releases', async () => {
  const s = await store(), release = await s.acquire();
  await assert.rejects(s.acquire(), /lock exists/); await release(); await (await s.acquire())();
});
