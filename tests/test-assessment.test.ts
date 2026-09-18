import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPlan } from '../src/test-assessment.js';
import { validatePlan } from '../src/agent.js';
import { result, testCase, answer, agent, store } from './helpers.js';
import { runPipeline } from '../src/pipeline.js';
import { configSchema } from '../src/config.js';
import type { TestPlan, TestCase } from '../src/types.js';

const file = 'test/feature.test.js', description = 'Add a new export that returns the greeting.';
const plan: TestPlan = { summary: 'New greeting', tests: [{ path: file, content: 'test("works", () => {});' }],
  scenarios: [{ name: 'works', requirement: 'Greeting', testFile: file, kind: 'new_behavior', requirementQuote: description }] };
const original = result();
function augmented(status: TestCase['status']) {
  return result(status === 'failed' ? 'failed' : 'passed', [testCase(), testCase(file, status)]);
}
test('classification distinguishes preserved behavior, regressions, new behavior and ambiguous failures', () => {
  for (const [base, head, outcome, eligible] of [
    ['passed', 'passed', 'preserved', true], ['passed', 'failed', 'regression', true],
    ['failed', 'passed', 'new_behavior_verified', true], ['failed', 'failed', 'unresolved', false],
    ['skipped', 'passed', 'unresolved', false], ['passed', 'skipped', 'unresolved', false]
  ] as const) {
    const assessment = assessPlan(plan, original, original, augmented(base), augmented(head));
    assert.equal(assessment.cases[0]?.outcome, outcome); assert.equal(assessment.eligible, eligible);
  }
});
test('regression labels cannot exempt failing baselines', () => {
  const regression: TestPlan = { ...plan, scenarios: plan.scenarios.map(s => ({ ...s, kind: 'regression' })) };
  assert.equal(assessPlan(regression, original, original, augmented('failed'), augmented('passed')).eligible, false);
});
test('discovery changes and infrastructure errors remain blocked', () => {
  assert.equal(assessPlan(plan, original, original, result(), augmented('passed')).eligible, false);
  assert.equal(assessPlan(plan, original, original, { ...augmented('failed'), status: 'error' }, augmented('passed')).eligible, false);
  const renamed = augmented('passed'); renamed.cases[1] = { ...testCase(file), id: 'renamed', name: 'renamed' };
  assert.equal(assessPlan(plan, original, original, augmented('failed'), renamed).eligible, false);
});
test('generated tests cannot repair or break original tests through side effects', () => {
  const failedOriginal = result('failed');
  assert.equal(assessPlan(plan, original, failedOriginal, augmented('passed'), augmented('passed')).eligible, false);
  const brokenBase = augmented('failed'); brokenBase.cases[0] = testCase(undefined, 'failed');
  assert.equal(assessPlan(plan, original, original, brokenBase, augmented('passed')).eligible, false);
});
test('new-behavior plans require exact request evidence and separate files', () => {
  const response = { ...answer(plan.tests), scenarios: plan.scenarios };
  assert.throws(() => validatePlan(response, new Map(), 'Different request'), /exact requirement quote/);
  assert.equal(validatePlan(response, new Map(), description).scenarios[0]?.kind, 'new_behavior');
  assert.throws(() => validatePlan({ ...response, scenarios: [...response.scenarios,
    { name: 'regression', requirement: 'preserve', testFile: file, kind: 'regression' }] }, new Map(), description), /Separate/);
});
const config = configSchema.parse({ repository: 'example/project', agent: { enabled: true, repair: true } });
test('a new feature can pass without requiring generated tests to pass on base', async () => {
  const a = agent(); a.plan = async () => ({ ...answer(plan.tests), scenarios: plan.scenarios });
  a.repair = async () => { throw new Error('No repair expected'); };
  const report = await runPipeline({ base: new Map([['src/a.ts', 'old']]), head: new Map([['src/a.ts', 'new']]),
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), description }, config, await store(),
    { run: async (_files, phase) => phase === 'planned-base' ? augmented('failed') : phase === 'planned-head' ? augmented('passed') : original }, a);
  assert.equal(report.status, 'passed'); assert.equal(report.testAssessment?.cases[0]?.outcome, 'new_behavior_verified');
  assert.equal(report.attempts, 0);
});
test('mixed new behavior and regression repairs retain both frozen tests', async () => {
  const regressionFile = 'test/regression.test.js';
  const a = agent();
  a.plan = async () => ({ ...answer([...plan.tests, { path: regressionFile, content: 'test("works", () => {});' }]),
    scenarios: [...plan.scenarios, { name: 'works', requirement: 'Keep original behavior', testFile: regressionFile, kind: 'regression' }] });
  const report = await runPipeline({ base: new Map([['src/a.ts', 'BASE']]), head: new Map([['src/a.ts', 'BAD']]),
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), description }, config, await store(), {
    run: async files => {
      if (!files.has(file)) return original;
      const cases = [testCase(), testCase(file, files.get('src/a.ts') === 'BASE' ? 'failed' : 'passed'),
        testCase(regressionFile, files.get('src/a.ts') === 'BAD' ? 'failed' : 'passed')];
      return result(cases.some(c => c.status === 'failed') ? 'failed' : 'passed', cases);
    }
  }, a);
  assert.equal(report.status, 'verified');
  assert.deepEqual(report.testAssessment?.cases.map(c => c.outcome), ['new_behavior_verified', 'regression']);
  assert.equal(report.changes.length, 3);
});
test('new behavior that fails on both revisions requires review without repair', async () => {
  const a = agent(); a.plan = async () => ({ ...answer(plan.tests), scenarios: plan.scenarios });
  a.repair = async () => { throw new Error('Ambiguous evidence must not trigger repair'); };
  const report = await runPipeline({ base: new Map(), head: new Map(), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), description },
    config, await store(), { run: async (_files, phase) => phase.startsWith('planned-') ? augmented('failed') : original }, a);
  assert.equal(report.status, 'needs_attention'); assert.equal(report.attempts, 0);
});
