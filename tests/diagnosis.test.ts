import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../src/application/pipeline.js';
import { configSchema } from '../src/domain/config.js';
import { assessStability, diagnose } from '../src/domain/test-diagnosis.js';
import type { TestResult } from '../src/domain/types.js';
import { agent, result, store, testCase } from './helpers.js';

const config = configSchema.parse({ repository: 'owner/repo', retry: { baseDelayMs: 0 },
  runner: { command: ['node', '--test'], environmentAttempts: 2 }, agent: { enabled: true, repair: true } });
const base = new Map([['src/a.ts', 'GOOD']]);
const input = { base, head: new Map(base), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const environment = (retryable = true): TestResult => ({ ...result('error'), failure: { kind: 'environment', retryable } });

test('diagnosis never treats assertions, discovery or malformed reports as transient environment failures', () => {
  assert.equal(diagnose(result('failed')).failure?.kind, 'test_failure');
  assert.equal(diagnose(result('not_run')).failure?.kind, 'test_discovery');
  assert.deepEqual(diagnose(result('error')).failure, { kind: 'invalid_report', retryable: false });
  assert.equal(diagnose(result('passed')).failure, undefined);
});

test('stability separates changing failures from missing evidence and missing passing cases', () => {
  const red = result('failed', [testCase('a.js', 'failed'), testCase('b.js')]);
  assert.equal(assessStability(red, red).status, 'stable');
  assert.equal(assessStability(red, result('passed', [testCase('a.js'), testCase('b.js')])).status, 'unstable');
  assert.equal(assessStability(red, environment()).status, 'inconclusive');
  assert.equal(assessStability(red, result('failed', [testCase('a.js', 'failed')])).status, 'inconclusive');
});

test('transient environment recovery repeats only its phase and retains every execution', async () => {
  const phases: string[] = [];
  const report = await runPipeline(input, config, await store(), { run: async (_files, phase) => {
    phases.push(phase); return phases.length === 1 ? environment() : result('passed');
  } });
  assert.equal(report.status, 'passed'); assert.deepEqual(phases, ['base', 'base', 'head']);
  assert.deepEqual(report.evidence.map(e => e.execution), [1, 2, 1]);
  assert.equal(report.evidence[0]?.result.failure?.kind, 'environment');
});

test('environment retries are bounded while nonretryable results execute once per phase', async () => {
  for (const [failure, count] of [[environment(), 4], [environment(false), 2], [result('error'), 2],
    [result('failed'), 2], [result('not_run'), 2]] as const) {
    let calls = 0;
    const report = await runPipeline(input, config, await store(), { run: async () => { calls++; return failure; } });
    assert.equal(calls, count); assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 0);
  }
});

test('cancellation after failed environment execution prevents its retry', async () => {
  const abort = new AbortController(); let calls = 0;
  const report = await runPipeline(input, config, await store(), { run: async () => {
    calls++; abort.abort(new Error('cancelled')); return environment();
  } }, undefined, abort.signal);
  assert.equal(calls, 1); assert.equal(report.status, 'cancelled');
});

test('exhausted repair environment retries never request another source patch', async () => {
  const policy = JSON.stringify({ rules: [{ id: 'bad', forbiddenText: 'BAD', extensions: ['.ts'], message: 'bad' }] });
  const before = new Map([...base, ['.repopilot/policy.json', policy]]);
  const head = new Map(before); head.set('src/a.ts', 'BAD');
  const model = agent(); let repairs = 0, verification = 0;
  const repair = model.repair.bind(model);
  model.repair = async (...args) => { repairs++; return repair(...args); };
  const report = await runPipeline({ ...input, base: before, head }, config, await store(), { run: async (files, phase) => {
    if (phase === 'repair') { verification++; return environment(); }
    return result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]);
  } }, model);
  assert.equal(repairs, 1); assert.equal(verification, 2); assert.equal(report.status, 'needs_attention');
  assert.equal(report.repairs[0]?.accepted, false); assert.deepEqual(report.changes, []);
});
