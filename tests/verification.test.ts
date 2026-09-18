import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { execute } from '../src/process.js';
import { classifyTestResult, sameFailures, testId } from '../src/test-results.js';
import { result, testCase, answer } from './helpers.js';
import { validatePlan } from '../src/agent.js';
import { withFreshness, StaleTaskError, retry, RetryableError } from '../src/control.js';
import { contextBatches } from '../src/context.js';
const nodeOutput = (cases: unknown[]) => JSON.stringify({ format: 'repopilot-node-v1', cases, infrastructureErrors: [] });
test('zero, skipped, invalid, duplicate, outside-root and inconsistent reports cannot pass', () => {
  const c = { file: '/tmp/work/a.test.js', name: 'case', status: 'passed', durationMs: 1 };
  for (const [stdout, code] of [
    [nodeOutput([]), 0], [nodeOutput([{ ...c, status: 'skipped' }]), 0],
    ['not json', 0], [nodeOutput([c, c]), 0], [nodeOutput([{ ...c, file: '/etc/other' }]), 0], [nodeOutput([c]), 1]
  ] as const) {
    const parsed = classifyTestResult({ stdout, code, stderr: '', timedOut: false }, 'node', 1);
    assert.notEqual(parsed.status, 'passed');
  }
  const command = classifyTestResult({ stdout: '', stderr: '', code: 0, timedOut: false }, 'command', 1);
  assert.equal(command.status, 'not_run');
});
test('Vitest JSON preserves full test identity and failures', () => {
  const stdout = JSON.stringify({ success: false, numTotalTests: 2, testResults: [{ name: '/tmp/work/a.test.ts',
    assertionResults: [{ fullName: 'suite good', status: 'passed', duration: 1 },
      { fullName: 'suite bad', status: 'failed', failureMessages: ['AssertionError: expected 1, received 2'] }] }] });
  const parsed = classifyTestResult({ stdout, stderr: '', code: 1, timedOut: false }, 'vitest', 1);
  assert.equal(parsed.status, 'failed'); assert.equal(parsed.cases[1]?.id, testId('a.test.ts', 'suite bad'));
  assert.ok(parsed.cases[1]?.fingerprint); assert.equal(sameFailures(parsed, parsed), true);
});
test('Node reporter consumes real local synthetic test events, including nested suites and skips', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/reporter-'));
  const reporter = resolve(root, 'reporter.mjs');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const source = await readFile(new URL('../src/node-reporter.ts', import.meta.url), 'utf8');
  await writeFile(reporter, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  await writeFile(resolve(root, 'example.test.mjs'),
    'import { test, describe } from "node:test"; import assert from "node:assert/strict";\n' +
    'describe("suite", () => { test("good", () => assert.equal(1,1)); test("bad", () => assert.equal(1,2)); test.skip("skip", () => {}); });\n');
  const output = await execute(process.execPath, ['--test', '--test-reporter=' + pathToFileURL(reporter).href, 'example.test.mjs'], { cwd: root, env });
  const parsed = classifyTestResult(output, 'node', 1, root);
  assert.equal(parsed.status, 'failed', JSON.stringify(parsed));
  assert.deepEqual(parsed.cases.map(c => [c.name, c.status]), [['suite > good', 'passed'], ['suite > bad', 'failed'], ['suite > skip', 'skipped']]);
  const repeat = classifyTestResult(await execute(process.execPath, ['--test', '--test-reporter=' + pathToFileURL(reporter).href, 'example.test.mjs'], { cwd: root, env }), 'node', 1, root);
  assert.equal(sameFailures(parsed, repeat), true);
  await writeFile(resolve(root, 'example.test.mjs'), 'throw new Error("failed to load");');
  const invalid = classifyTestResult(await execute(process.execPath, ['--test', '--test-reporter=' + pathToFileURL(reporter).href, 'example.test.mjs'], { cwd: root, env }), 'node', 1, root);
  assert.equal(invalid.status, 'error');
});
test('frozen test plan rejects disabled tests and unmapped scenarios', () => {
  const plan = { ...answer([{ path: 'test/new.test.js', content: 'test.skip("x", () => {});' }]),
    scenarios: [{ name: 'x', requirement: 'behavior', testFile: 'test/new.test.js' }] };
  assert.throws(() => validatePlan(plan, new Map()), /disabled/);
  plan.changes[0]!.content = 'test("x", () => {});'; plan.scenarios[0]!.testFile = 'other.test.js';
  assert.throws(() => validatePlan(plan, new Map()), /map/);
});
test('retry backoff is bounded and permanent errors are never retried', async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(retry(async () => { calls++; throw new RetryableError('temporary'); },
    { attempts: 3, baseDelayMs: 10, maxDelayMs: 15 }, undefined, async ms => { waits.push(ms); }), /temporary/);
  assert.equal(calls, 3); assert.deepEqual(waits, [10, 15]);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('permanent'); }, { attempts: 3, baseDelayMs: 0, maxDelayMs: 1 }), /permanent/);
  assert.equal(calls, 1);
});
test('freshness monitor aborts pending work and active subprocess accepts cancellation', async () => {
  await assert.rejects(withFreshness(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), async () => false, 5), StaleTaskError);
  const controller = new AbortController();
  const running = execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled fixture')), 30);
  await assert.rejects(running, /cancelled fixture/);
});
test('context batches include scoped rules and relevant imports within budget', () => {
  const base = new Map([['AGENTS.md', 'Keep invariants.'], ['src/a.ts', 'export const a = 0;'],
    ['src/b.ts', 'export const b = 1;'], ['irrelevant.txt', 'x'.repeat(1000000)]]);
  const head = new Map(base); head.set('src/a.ts', 'import {b} from "./b.js"; export const a = b;');
  const batches = contextBatches(base, head);
  assert.equal(batches.length, 1); assert.equal(batches[0]?.diff[0]?.rules[0]?.content, 'Keep invariants.');
  assert.ok(batches[0]?.files.some(f => f.path === 'src/b.ts'));
  assert.ok(!JSON.stringify(batches).includes('irrelevant.txt'));
});
