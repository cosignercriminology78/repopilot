import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedAgentBudget } from '../src/adapters/codex/docker-agent.js';
import { runPipeline } from '../src/application/pipeline.js';
import { markdownReport } from '../src/reporting/markdown.js';
import { configSchema } from '../src/domain/config.js';
import type { AgentRole } from '../src/domain/collaboration.js';
import type { Agent } from '../src/ports/agent.js';
import type { Runner } from '../src/ports/runner.js';
import { answer, result, store, testCase } from './helpers.js';

const criterion = 'Negative quantities produce a validation error.';

test('role team routes planning, implementation and review through separate agents with durable handoffs', async () => {
  const calls: AgentRole[] = [], reports = await store();
  let observedRunning = false;
  const reviewer: Agent = { review: async () => {
    observedRunning ||= (await reports.list())[0]?.handoffs?.at(-1)?.status === 'running';
    calls.push('reviewer'); return answer();
  },
    plan: async () => assert.fail('Reviewer cannot plan tests'), repair: async () => assert.fail('Reviewer cannot repair') };
  const tester: Agent = { review: async () => assert.fail('Tester cannot review'),
    plan: async () => { calls.push('tester'); return { ...answer([{ path: 'test/generated.test.js', content: 'test("works", () => {});' }]),
      scenarios: [{ name: 'works', requirement: criterion, requirementQuote: criterion, kind: 'new_behavior', testFile: 'test/generated.test.js' }] }; },
    repair: async () => assert.fail('Tester cannot repair') };
  const developer: Agent = { review: async () => assert.fail('Developer cannot review'),
    plan: async () => assert.fail('Developer cannot plan tests'),
    repair: async () => { calls.push('developer'); return answer([{ path: 'src/a.ts', content: 'GOOD' }]); } };
  const planner: Agent = { review: async () => assert.fail('Planner cannot review'),
    plan: async () => assert.fail('Planner cannot plan tests'), repair: async () => assert.fail('Planner cannot repair') };
  const roles = { planner, tester, developer, reviewer };
  const team: Agent = { review: reviewer.review, plan: tester.plan, repair: developer.repair,
    forRole: role => roles[role] };
  const base = new Map([['src/a.ts', 'BROKEN']]);
  const runner: Runner = { run: async files => {
    const cases = [testCase()];
    if (files.has('test/generated.test.js')) cases.push(testCase('test/generated.test.js', files.get('src/a.ts') === 'GOOD' ? 'passed' : 'failed'));
    return result(cases.some(item => item.status === 'failed') ? 'failed' : 'passed', cases);
  } };
  const config = configSchema.parse({ repository: 'owner/repo', agent: { enabled: true, repair: true },
    iteration: { collaboration: {} } });
  const report = await runPipeline({ base, head: base, baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40), description: criterion,
    implementation: { mode: 'feature', acceptance: [criterion], allowedPaths: ['src', 'test'] } },
  config, reports, runner, team);
  assert.equal(report.status, 'verified');
  assert.equal(observedRunning, true);
  assert.deepEqual(new Set(calls), new Set<AgentRole>(['reviewer', 'tester', 'developer']));
  assert.ok(report.handoffs?.length);
  assert.equal(report.handoffs?.filter(item => item.role === 'tester').length, 1);
  assert.equal(report.handoffs?.filter(item => item.role === 'developer').length, 1);
  assert.ok(report.handoffs?.filter(item => item.role === 'reviewer').length! >= 3);
  assert.ok(report.handoffs?.every(item => item.status === 'completed'));
  assert.ok(report.handoffs?.every(item => item.inputDigest.length === 24 && item.outputDigest?.length === 24));
  assert.match(markdownReport(report), /tester\/test_plan: completed/);
});

test('shared role budget is aggregate and preserves unknown usage', () => {
  const budget = new SharedAgentBudget(2, 1000);
  budget.reserveCall(); budget.beginUnaccounted();
  assert.equal(budget.usage().complete, false);
  budget.settle(400); budget.reserveCall();
  assert.deepEqual(budget.usage(), { calls: 2, tokens: 400, complete: true });
  assert.throws(() => budget.reserveCall(), /budget exhausted/);
  budget.beginUnaccounted();
  assert.equal(budget.usage().complete, false);
  budget.reset();
  assert.deepEqual(budget.usage(), { calls: 0, tokens: 0, complete: true });
});

test('collaboration role configuration is strict and inherits role defaults', () => {
  const config = configSchema.parse({ repository: 'owner/repo', iteration: { collaboration: {
    roles: { planner: { model: 'planning-model' }, tester: {}, developer: {}, reviewer: { model: 'review-model' } }
  } } });
  assert.equal(config.iteration?.collaboration?.roles.planner.model, 'planning-model');
  assert.equal(config.iteration?.collaboration?.roles.tester.model, undefined);
  assert.throws(() => configSchema.parse({ repository: 'owner/repo', iteration: { collaboration: { unsafe: true } } }));
});
