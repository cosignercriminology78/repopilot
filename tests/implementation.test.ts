import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../src/application/pipeline.js';
import { configSchema } from '../src/domain/config.js';
import type { Agent } from '../src/ports/agent.js';
import type { Runner } from '../src/ports/runner.js';
import { answer, result, store, testCase } from './helpers.js';

const criterion = 'Negative quantities produce a validation error.';
const base = new Map([['src/a.ts', 'BROKEN']]);
const input = { base, head: base, baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40), description: criterion,
  implementation: { mode: 'feature' as const, acceptance: [criterion], allowedPaths: ['src', 'test'] } };
const config = configSchema.parse({ repository: 'owner/repo', agent: { enabled: true, repair: true, maxAttempts: 3 } });
function model(): Agent { return {
  review: async () => answer(),
  plan: async () => ({ ...answer([{ path: 'test/generated.test.js', content: 'test("works", () => {});' }]),
    scenarios: [{ name: 'works', requirement: criterion, requirementQuote: criterion, kind: 'new_behavior', testFile: 'test/generated.test.js' }] }),
  repair: async () => answer([{ path: 'src/a.ts', content: 'GOOD' }])
}; }
const runner: Runner = { run: async files => {
  const cases = [testCase()];
  if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js', files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed'));
  return result(cases.some(c => c.status === 'failed') ? 'failed' : 'passed', cases);
} };

test('feature implementation demonstrates missing behavior before changing production and preserves frozen acceptance tests', async () => {
  const report = await runPipeline(input, config, await store(), runner, model());
  assert.equal(report.status, 'verified');
  assert.equal(report.tests.base.status, 'passed');
  assert.equal(report.evidence.find(e => e.phase === 'planned-base')?.result.status, 'failed');
  assert.equal(report.testStability?.status, 'stable');
  assert.equal(report.tests.repaired?.status, 'passed');
  assert.deepEqual(report.changes.map(c => c.path).sort(), ['src/a.ts', 'test/generated.test.js']);
});

test('feature planning refuses uncited acceptance, omitted acceptance and tests outside allowed paths', async () => {
  for (const variant of ['quote', 'coverage', 'scope']) {
    const m = model();
    if (variant === 'quote') { const plan = m.plan; m.plan = async (...args) => { const a = await plan(...args); a.scenarios[0]!.requirementQuote = 'Unrelated requirements'; return a; }; }
    const implementation = { ...input.implementation,
      acceptance: variant === 'coverage' ? [criterion, 'Zero quantities must also be rejected.'] : [criterion],
      allowedPaths: variant === 'scope' ? ['src'] : ['src', 'test'] };
    m.repair = async () => { assert.fail('Invalid plan must never reach repair'); };
    const report = await runPipeline({ ...input, implementation }, config, await store(), runner, m);
    assert.equal(report.status, 'error', variant); assert.equal(report.attempts, 0);
  }
});

test('feature repairs cannot expand scope or modify frozen tests', async () => {
  for (const path of ['other/a.ts', 'test/generated.test.js']) {
    const m = model(); m.repair = async () => answer([{ path, content: 'GOOD' }]);
    const report = await runPipeline(input, config, await store(), runner, m);
    assert.equal(report.status, 'needs_attention'); assert.deepEqual(report.changes, []);
    assert.match(report.repairs[0]!.reason ?? '', /allowed paths|frozen tests/);
  }
});

test('identical failed patches terminate instead of consuming all repair attempts', async () => {
  const m = model(); let calls = 0;
  m.repair = async () => { calls++; return answer([{ path: 'src/a.ts', content: 'STILL_BROKEN' }]); };
  const report = await runPipeline(input, config, await store(), runner, m);
  assert.equal(calls, 2); assert.equal(report.status, 'needs_attention');
  assert.equal(report.evidence.filter(e => e.phase === 'repair').length, 1);
  assert.match(report.repairs[1]!.reason ?? '', /Repeated patch/);
});

test('already passing feature criteria verify new acceptance tests without production changes', async () => {
  const m = model(); m.repair = async () => { assert.fail('Already passing tests cannot justify a repair'); };
  const green: Runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
  const report = await runPipeline(input, config, await store(), green, m);
  assert.equal(report.status, 'verified'); assert.equal(report.attempts, 0);
  assert.deepEqual(report.changes.map(c => c.path), ['test/generated.test.js']);
  assert.equal(report.tests.repaired?.status, 'passed');
});



test('already passing acceptance tests cannot bypass static policy review', async () => {
  const m = model(), plan = m.plan;
  m.plan = async (...args) => {
    const planned = await plan(...args); planned.changes[0]!.content = 'test("works", () => { forbidden(); });'; return planned;
  };
  m.repair = async () => { assert.fail('Passing acceptance tests cannot authorize production repair'); };
  const policyBase = new Map([...base, ['.repopilot/policy.json', JSON.stringify({ rules: [{ id: 'forbidden',
    kind: 'forbid-call', callee: 'forbidden', message: 'Forbidden operation' }] })]]);
  const green: Runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
  const report = await runPipeline({ ...input, base: policyBase, head: policyBase }, config, await store(), green, m);
  assert.equal(report.status, 'needs_attention'); assert.deepEqual(report.changes, []); assert.equal(report.attempts, 0);
  assert.match(report.notes.join('\n'), /policy review/);
});

test('bugfix mode cannot accept all-green tests as proof that a reported bug was reproduced', async () => {
  const m = model(), plan = m.plan;
  m.plan = async (...args) => { const planned = await plan(...args); planned.scenarios[0]!.kind = 'regression'; return planned; };
  m.repair = async () => { assert.fail('Unreproduced bug must not request a repair'); };
  const green: Runner = { run: async files => result('passed', [testCase(), ...(files.has('test/generated.test.js') ? [testCase('test/generated.test.js')] : [])]) };
  const report = await runPipeline({ ...input, implementation: { ...input.implementation, mode: 'bugfix' } }, config, await store(), green, m);
  assert.equal(report.status, 'needs_attention'); assert.deepEqual(report.changes, []); assert.equal(report.attempts, 0);
});
