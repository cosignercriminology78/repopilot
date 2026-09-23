import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { FileIterationStore } from '../src/adapters/storage/iteration-store.js';
import { createGoal, runGoal, type IterationDependencies } from '../src/application/iteration.js';
import { configSchema } from '../src/domain/config.js';
import { goalSpecSchema, validateSteps, withinScope, type GoalStep } from '../src/domain/iteration.js';
import { parallelCapacity, partitionParallelBranches } from '../src/domain/parallel-scheduling.js';
import type { Runner } from '../src/ports/runner.js';
import { RetryableError } from '../src/shared/control.js';
import { answer, result, store, testCase } from './helpers.js';

const spec = goalSpecSchema.parse({ title: 'Implement quantity validation', objective: 'Reject invalid quantities before creating an order.', mode: 'feature',
  acceptance: [{ id: 'negative', text: 'Negative quantities produce a validation error.' }, { id: 'zero', text: 'Zero quantities produce a validation error.' }],
  allowedPaths: ['src', 'test'] });
const steps: GoalStep[] = [
  { id: 'negative', title: 'Reject negative quantities', acceptanceIds: ['negative'], dependsOn: [] },
  { id: 'zero', title: 'Reject zero quantities', acceptanceIds: ['zero'], dependsOn: ['negative'] }
];
const sha = 'a'.repeat(40);
async function fixture(): Promise<IterationDependencies> {
  await mkdir('.cache/tests', { recursive: true });
  const dataDir = await mkdtemp(resolve('.cache/tests/iteration-'));
  const base = new Map([['src/negative.ts', 'BROKEN'], ['src/zero.ts', 'BROKEN']]);
  const config = configSchema.parse({ repository: 'owner/repo', dataDir, agent: { enabled: true, repair: true, maxCalls: 8, maxTokens: 1000 }, iteration: { maxCalls: 100, maxTokens: 10000 } });
  const runner: Runner = { run: async files => {
    const cases = [testCase()];
    for (const id of ['negative', 'zero']) if (files.has(`test/${id}.test.js`)) cases.push(testCase(`test/${id}.test.js`, files.get(`src/${id}.ts`) === 'GOOD' ? 'passed' : 'failed'));
    return result(cases.some(c => c.status === 'failed') ? 'failed' : 'passed', cases);
  } };
  return { config, goals: new FileIterationStore(dataDir), store: await store(), runner,
    signal: new AbortController().signal,
    github: { target: async () => ({ branch: 'main', sha }), issue: async () => { throw new Error('No Issue lookup'); },
      listPulls: async () => [], pull: async () => { throw new Error('No PR lookup'); }, current: async () => ({ number: 1, title: spec.title, body: spec.objective, state: 'open' }),
      publish: async () => { assert.fail('publish=false must never write GitHub'); } },
    repository: { prepare: async () => {}, fetch: async (_path, _repo, a, b) => { assert.equal(a, sha); assert.equal(b, sha); },
      snapshot: async () => base, resolveCommit: async () => sha },
    agent: { design: async () => ({ ...answer(), steps }), review: async () => answer(),
      plan: async (_base, _head, description) => {
        const criterion = spec.acceptance.find(a => description.includes(a.text))!;
        const path = `test/${criterion.id}.test.js`;
        return { ...answer([{ path, content: 'test("works", () => {});' }]), scenarios: [{ name: 'works', requirement: criterion.text,
          requirementQuote: criterion.text, kind: 'new_behavior', testFile: path }] };
      },
      repair: async (_base, head) => answer(['negative', 'zero'].filter(id => head.has(`test/${id}.test.js`) && head.get(`src/${id}.ts`) !== 'GOOD')
        .map(id => ({ path: `src/${id}.ts`, content: 'GOOD' }))) }
  };
}
async function parallelFixture() {
  const d = await fixture();
  d.config.iteration!.collaboration = configSchema.parse({ repository: 'owner/repo',
    iteration: { collaboration: { maxParallel: 2 } } }).iteration!.collaboration;
  const independent = [{ ...steps[0]!, dependsOn: [] }, { ...steps[1]!, dependsOn: [] }];
  const core = d.agent!;
  core.design = async () => ({ ...answer(), steps: independent });
  let calls = 0;
  core.forkExecution = () => ({
    review: async (...args) => { calls++; return core.review(...args); },
    plan: async (...args) => { calls++; return core.plan(...args); },
    repair: async (...args) => { calls++; return core.repair(...args); },
    usage: () => ({ calls: 4, tokens: 40 }),
    resetBudget: () => {}
  });
  return { d, calls: () => calls };
}

test('independent DAG nodes execute concurrently and merge only after cumulative tests pass', async () => {
  const { d } = await parallelFixture();
  const core = d.agent!, plan = core.plan;
  let waiting = 0, release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  core.plan = async (...args) => {
    if (++waiting === 2) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([bothStarted, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Independent nodes did not run concurrently.')), 3000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    return plan(...args);
  };
  const phases: string[] = [], runner = d.runner!;
  d.runner = { run: async (files, phase, signal) => { phases.push(phase); return runner.run(files, phase, signal); } };
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'verified', finished.notes.join('\n'));
  assert.deepEqual(finished.completed, ['negative', 'zero']);
  assert.equal(waiting, 2);
  assert.ok(phases.includes('goal-merge-base') && phases.includes('goal-merge'));
  assert.equal(finished.parallelBatch, undefined);
  assert.equal(finished.reports.length, 2);
  assert.equal(finished.waveHistory?.[0]?.status, 'merged');
  assert.deepEqual(finished.waveHistory?.[0]?.accepted, ['negative', 'zero']);
});

test('parallel file conflicts replay the later node on the verified updated snapshot', async () => {
  const { d } = await parallelFixture();
  d.agent!.repair = async () => answer([{ path: 'src/shared.ts', content: 'GOOD' }]);
  d.runner = { run: async files => {
    const cases = [testCase()];
    for (const id of ['negative', 'zero']) if (files.has(`test/${id}.test.js`))
      cases.push(testCase(`test/${id}.test.js`, files.get('src/shared.ts') === 'GOOD' ? 'passed' : 'failed'));
    return result(cases.some(item => item.status === 'failed') ? 'failed' : 'passed', cases);
  } };
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'verified', finished.notes.join('\n'));
  assert.deepEqual(finished.completed, ['negative', 'zero']);
  assert.deepEqual([finished.stepStates?.negative?.attempts, finished.stepStates?.zero?.attempts], [1, 2]);
  assert.equal(finished.reports.length, 3);
  assert.equal(finished.waveHistory?.[0]?.status, 'partial');
  assert.deepEqual(finished.waveHistory?.[0]?.accepted, ['negative']);
  assert.deepEqual(finished.waveHistory?.[0]?.deferred, ['zero']);
  assert.deepEqual(finished.waveHistory?.[0]?.conflicts, [{ path: 'src/shared.ts', owner: 'negative', deferred: 'zero' }]);
  assert.deepEqual(finished.serialReplay, []);
});

test('paused conflict replay resumes from the accepted snapshot without repeating the wave', async () => {
  const { d } = await parallelFixture();
  d.agent!.repair = async () => answer([{ path: 'src/shared.ts', content: 'GOOD' }]);
  d.runner = { run: async (files, phase) => {
    const cases = [testCase()];
    for (const id of ['negative', 'zero']) if (files.has(`test/${id}.test.js`))
      cases.push(testCase(`test/${id}.test.js`, files.get('src/shared.ts') === 'GOOD' ? 'passed' : 'failed'));
    const evidence = result(cases.some(item => item.status === 'failed') ? 'failed' : 'passed', cases);
    if (phase === 'goal-merge') await d.goals.pause(created.id);
    return evidence;
  } };
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'paused');
  assert.deepEqual(first.completed, ['negative']);
  assert.deepEqual(first.serialReplay, ['zero']);
  assert.equal(first.waveHistory?.length, 1);
  const resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'verified', resumed.notes.join('\n'));
  assert.deepEqual(resumed.completed, ['negative', 'zero']);
  assert.equal(resumed.waveHistory?.length, 1);
  assert.equal(resumed.rounds, first.rounds + 1);
  assert.equal(resumed.stepStates?.negative?.attempts, 1);
});

test('parallel resource budget reduces worker capacity without losing DAG progress', async () => {
  const { d } = await parallelFixture();
  d.config.iteration!.collaboration!.resourceBudget = { cpus: 4, memoryMiB: 3072 };
  assert.equal(parallelCapacity(d.config.iteration!.collaboration, undefined), 1);
  const serviceRunner = configSchema.parse({ repository: 'owner/repo', runner: { command: ['node', '--test'],
    services: [{ name: 'db', image: 'postgres:16', readiness: { command: ['true'] } }] } }).runner!;
  assert.equal(parallelCapacity({ ...d.config.iteration!.collaboration!, resourceBudget: { cpus: 8, memoryMiB: 6144 } }, serviceRunner), 1);
  assert.throws(() => parallelCapacity({ ...d.config.iteration!.collaboration!, resourceBudget: { cpus: 3, memoryMiB: 3072 } }, undefined),
    /cannot accommodate one node/);
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'verified', finished.notes.join('\n'));
  assert.deepEqual(finished.completed, ['negative', 'zero']);
  assert.equal(finished.waveHistory, undefined);
});

test('parallel branch partition keeps deterministic owners and defers only overlapping edits', () => {
  const base = new Map([['src/a.ts', 'old'], ['src/b.ts', 'old']]);
  const decision = partitionParallelBranches(base, [
    { step: 'one', changes: [{ path: 'src/a.ts', content: 'new' }] },
    { step: 'two', changes: [{ path: 'src/a.ts', content: 'new' }] },
    { step: 'three', changes: [{ path: 'src/b.ts', content: 'new' }] }
  ]);
  assert.deepEqual(decision.accepted.map(branch => branch.step), ['one', 'three']);
  assert.deepEqual(decision.deferred, ['two']);
  assert.deepEqual(decision.pathOwners, { 'src/a.ts': 'one', 'src/b.ts': 'three' });
});

test('parallel failure keeps independently verified sibling and blocks final publication', async () => {
  const { d } = await parallelFixture(), repair = d.agent!.repair;
  d.agent!.repair = async (base, head, prompt, signal) => head.has('test/zero.test.js')
    ? answer([]) : repair(base, head, prompt, signal);
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention');
  assert.deepEqual(first.completed, ['negative']);
  assert.equal(first.stepStates?.negative?.status, 'completed');
  assert.equal(first.stepStates?.zero?.status, 'rejected');
  assert.equal(first.publication, undefined);
  assert.equal(first.waveHistory?.[0]?.status, 'partial');
  assert.deepEqual(first.waveHistory?.[0]?.rejected, ['zero']);
  d.agent!.repair = repair;
  const resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'verified', resumed.notes.join('\n'));
  assert.deepEqual(resumed.completed, ['negative', 'zero']);
});

test('retryable parallel transport failure replays only the failed step within the goal budget', async () => {
  const { d } = await parallelFixture(), review = d.agent!.review;
  d.config.retry.baseDelayMs = 0;
  let failures = 0;
  d.agent!.review = async (...args) => {
    if (args[2].includes('Zero quantities') && failures === 0) {
      failures++; throw new RetryableError('temporary Codex transport');
    }
    return review(...args);
  };
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'verified', finished.notes.join('\n'));
  assert.equal(failures, 1);
  assert.deepEqual(finished.completed, ['negative', 'zero']);
  assert.deepEqual([finished.stepStates?.negative?.attempts, finished.stepStates?.zero?.attempts], [1, 2]);
  assert.equal(finished.rounds, 3);
  assert.equal(finished.waveHistory?.[0]?.status, 'partial');
  assert.deepEqual(finished.waveHistory?.[0]?.rejected, ['zero']);
});

test('parallel retry limit stops repeated transport failures without publication', async () => {
  const { d, calls } = await parallelFixture();
  d.config.iteration!.maxRounds = 2;
  d.config.retry.baseDelayMs = 0;
  const review = d.agent!.review;
  d.agent!.review = async (...args) => args[2].includes('Zero quantities')
    ? Promise.reject(new RetryableError('persistent Codex transport')) : review(...args);
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention');
  assert.deepEqual(first.completed, ['negative']);
  assert.equal(first.stepStates?.zero?.attempts, 2);
  assert.equal(first.publication, undefined);
  const before = calls(), resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'needs_attention');
  assert.equal(calls(), before);
  assert.equal(resumed.rounds, first.rounds);
});

test('future retry window leaves replay durable without spending a premature execution', async () => {
  const { d, calls } = await parallelFixture(), review = d.agent!.review;
  d.agent!.review = async (...args) => args[2].includes('Zero quantities')
    ? Promise.reject(new RetryableError('Codex unavailable', 60000)) : review(...args);
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention');
  assert.deepEqual(first.completed, ['negative']);
  assert.deepEqual(first.serialReplay, ['zero']);
  assert.equal(first.rounds, 2);
  const before = calls(), resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'needs_attention');
  assert.equal(calls(), before);
  assert.equal(resumed.rounds, first.rounds);
  assert.deepEqual(resumed.serialReplay, ['zero']);
});

test('parallel merge cannot promote individually verified branches when their combined tests fail', async () => {
  const { d } = await parallelFixture(), runner = d.runner!;
  d.runner = { run: async (files, phase, signal) => {
    const evidence = await runner.run(files, phase, signal);
    return phase === 'goal-merge' ? result('failed', evidence.cases.map((item, index) =>
      index === 1 ? { ...item, status: 'failed' as const, failure: 'combined regression' } : item)) : evidence;
  } };
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'needs_attention');
  assert.deepEqual(finished.completed, []);
  assert.deepEqual(finished.changes, []);
  assert.match(finished.notes.join('\n'), /Parallel merge failed cumulative verification/);
});

test('parallel merge resumes from durable verified branches without repeating Agent calls', async () => {
  const { d, calls } = await parallelFixture(), runner = d.runner!;
  let interrupt = true;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'goal-merge' && interrupt) { interrupt = false; throw new Error('Merge runner interrupted'); }
    return runner.run(files, phase, signal);
  } };
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention');
  assert.equal(first.parallelBatch?.steps.every(step => step.settled), true);
  const before = calls(), resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'verified', resumed.notes.join('\n'));
  assert.equal(calls(), before);
  assert.equal(resumed.rounds, first.rounds);
  assert.deepEqual(resumed.completed, ['negative', 'zero']);
  assert.equal(resumed.waveHistory?.length, 1);
  assert.equal(resumed.waveHistory?.[0]?.status, 'merged');
});

test('parallel recovery refuses missing branch evidence without spending another Agent budget', async () => {
  const { d, calls } = await parallelFixture(), runner = d.runner!;
  let interrupt = true;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'goal-merge' && interrupt) { interrupt = false; throw new Error('Merge runner interrupted'); }
    return runner.run(files, phase, signal);
  } };
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention');
  const missing = first.reports[0]!.split(':')[1]!, read = d.store.read.bind(d.store);
  d.store.read = async id => id === missing ? undefined : read(id);
  const before = calls(), resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'needs_attention');
  assert.equal(calls(), before);
  assert.equal(resumed.calls, first.calls);
  assert.deepEqual(resumed.completed, []);
  assert.deepEqual(resumed.changes, []);
  assert.match(resumed.notes.join('\n'), /Interrupted parallel batch lacks terminal evidence/);
  assert.equal(resumed.waveHistory?.[0]?.status, 'interrupted');
});

test('parallel recovery rechecks saved candidate scope before merging', async () => {
  const { d, calls } = await parallelFixture(), runner = d.runner!;
  let interrupt = true;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'goal-merge' && interrupt) { interrupt = false; throw new Error('Merge runner interrupted'); }
    return runner.run(files, phase, signal);
  } };
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention');
  const changed = first.reports[0]!.split(':')[1]!, read = d.store.read.bind(d.store);
  d.store.read = async id => {
    const report = await read(id);
    return id === changed && report ? { ...report, changes: [{ path: 'outside/file.ts', content: 'UNVERIFIED' }] } : report;
  };
  const before = calls(), resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'needs_attention');
  assert.equal(calls(), before);
  assert.deepEqual(resumed.completed, []);
  assert.deepEqual(resumed.changes, []);
  assert.match(resumed.notes.join('\n'), /exceeds the goal allowed paths/);
});

test('goal plans must cover each criterion once with ordered dependencies and bounded scope', () => {
  assert.deepEqual(validateSteps(steps, spec, 2), steps);
  assert.throws(() => validateSteps(steps.slice(0, 1), spec, 2), /omitted/);
  assert.throws(() => validateSteps([...steps].reverse(), spec, 2), /dependency/);
  assert.throws(() => validateSteps([{ ...steps[0]!, acceptanceIds: ['negative', 'negative'] }, steps[1]!], spec, 2), /exactly one/);
  assert.throws(() => validateSteps(steps, spec, 1));
  assert.equal(withinScope('src/a.ts', ['src']), true);
  for (const path of ['src-extra/a.ts', '../src/a.ts', 'src/../a.ts']) assert.equal(withinScope(path, ['src']), false);
});

test('goal executes dependent steps, cumulatively verifies all acceptance tests and persists experience', async () => {
  const d = await fixture(), created = await createGoal(spec, d);
  assert.equal(created.status, 'planned');
  const finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'verified', finished.notes.join('\n'));
  assert.deepEqual(finished.completed, ['negative', 'zero']); assert.equal(finished.reports.length, 2);
  assert.deepEqual(Object.values(finished.stepStates ?? {}).map(step => step.status), ['completed', 'completed']);
  assert.equal(finished.stepStates?.negative?.reportId, finished.reports[0]!.split(':')[1]);
  assert.ok(finished.handoffs?.some(handoff => handoff.role === 'planner' && handoff.status === 'completed'));
  assert.equal(finished.changes.length, 4);
  assert.equal((await new FileIterationStore(d.config.dataDir).read(created.id))?.status, 'verified');
  assert.equal((await d.goals.experiences())[0]?.outcome, 'verified');
  const publication = await d.store.read(finished.publication!);
  assert.equal(publication?.tests.repaired?.cases.length, 3);
});

test('goal resume skips completed implementation but reruns cumulative verification', async () => {
  const d = await fixture(), runner = d.runner!;
  let interrupted = false;
  d.runner = { run: async (files, phase, signal) => {
    if (!interrupted && phase === 'goal-final') { interrupted = true; throw new Error('Interrupted before final verification'); }
    return runner.run(files, phase, signal);
  } };
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.status, 'needs_attention'); assert.equal(first.completed.length, 2);
  d.agent!.plan = async () => { assert.fail('Completed steps must not be planned again'); };
  const phases: string[] = [];
  d.runner = { run: async (files, phase, signal) => { phases.push(phase); return runner.run(files, phase, signal); } };
  const resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'verified'); assert.ok(phases.includes('goal-final'));
  assert.equal(resumed.rounds, first.rounds);
});

test('resume fails closed when stored completed-step evidence is missing', async () => {
  const d = await fixture(), created = await createGoal(spec, d), completed = await runGoal(created.id, d);
  assert.equal(completed.status, 'verified', completed.notes.join('\n'));
  assert.ok(completed.reports[0], `Expected completed-step evidence: ${JSON.stringify(completed)}`);
  const read = d.store.read.bind(d.store), missing = completed.reports[0].split(':')[1]!;
  d.store.read = async id => id === missing ? undefined : read(id);
  const resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'needs_attention');
  assert.match(resumed.notes.join('\n'), /evidence|completed step|verification/i);
});

test('goal refuses a plan beyond total model budget and does not refund unknown crash usage', async () => {
  const d = await fixture(); d.config.iteration!.maxCalls = d.config.agent.maxCalls;
  const created = await createGoal(spec, d);
  assert.equal(created.calls, d.config.agent.maxCalls);
  d.agent!.plan = async () => { assert.fail('Total budget must be reserved before model work'); };
  const finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'needs_attention'); assert.match(finished.notes.join('\n'), /budget exhausted/);
  assert.equal(finished.calls, created.calls);
});

test('configuration drift, source movement and expired crash deadlines stop goal execution', async () => {
  const d = await fixture(), created = await createGoal(spec, d);
  d.config.agent.maxCalls++;
  await assert.rejects(runGoal(created.id, d), /configuration changed/);
  d.config.agent.maxCalls--;
  d.github.target = async () => ({ branch: 'main', sha: 'b'.repeat(40) });
  assert.equal((await runGoal(created.id, d)).status, 'stale');
  const other = await fixture(), timed = await createGoal(spec, other);
  timed.activeSince = new Date(Date.now() - (other.config.iteration!.timeoutSeconds + 1) * 1000).toISOString();
  await other.goals.save(timed);
  await assert.rejects(runGoal(timed.id, other), /time budget exhausted/);
});

test('preview requires passing candidate health and a passing rollback rehearsal', async () => {
  for (const failingPhase of ['preview-candidate-health', 'preview-rollback-health']) {
    const d = await fixture();
    d.config.iteration!.preview = configSchema.parse({ repository: 'owner/repo', runner: { image: 'fixture:local', command: ['node', '--test'] } }).runner!;
    const phases: string[] = [];
    d.previewRunner = { run: async (_files, phase) => { phases.push(phase); return result(phase === failingPhase ? 'failed' : 'passed'); } };
    const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
    assert.equal(finished.status, 'needs_attention'); assert.equal(finished.publication, undefined);
    assert.deepEqual(phases, ['preview-candidate-health', 'preview-rollback-health']);
    assert.match(finished.notes.join('\n'), /Preview health|rollback/);
  }
});


test('goal pause persists across store instances and resume continues remaining steps', async () => {
  const d = await fixture(), created = await createGoal(spec, d), repair = d.agent!.repair;
  let pauseOnce = true;
  d.agent!.repair = async (...args) => {
    const patch = await repair(...args);
    if (pauseOnce) { pauseOnce = false; await new FileIterationStore(d.config.dataDir).pause(created.id); }
    return patch;
  };
  const paused = await runGoal(created.id, d);
  assert.equal(paused.status, 'paused'); assert.equal(await d.goals.paused(created.id), true);
  assert.equal((await runGoal(created.id, d)).status, 'verified');
  assert.equal(await d.goals.paused(created.id), false);
});

test('reported model usage refunds only unused reservation across planning and execution', async () => {
  const d = await fixture(); let resets = 0;
  d.agent!.resetBudget = () => { resets++; };
  d.agent!.usage = () => ({ calls: 1, tokens: 10 });
  const created = await createGoal(spec, d);
  assert.equal(created.calls, 1); assert.equal(created.tokens, 10);
  const finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'verified'); assert.equal(resets, 3);
  assert.equal(finished.calls, 3); assert.equal(finished.tokens, 30);
});

test('planning uses only experiences from the same repository commit and configuration', async () => {
  const d = await fixture(), first = await createGoal(spec, d);
  const entry = { id: first.id, goalId: first.id, repository: first.repository, sha: first.sha, configHash: first.configHash,
    outcome: 'verified' as const, completed: [], reportIds: [], notes: ['Relevant evidence'], createdAt: first.updatedAt };
  await d.goals.remember(entry);
  await d.goals.remember({ ...entry, id: 'b'.repeat(24), sha: 'b'.repeat(40), notes: ['Old revision'] });
  await d.goals.remember({ ...entry, id: 'c'.repeat(24), configHash: 'changed', notes: ['Other configuration'] });
  await d.goals.remember({ ...entry, id: 'd'.repeat(24), repository: 'other/repo', notes: ['Other repository'] });
  d.agent!.design = async (_base, context) => {
    const parsed = JSON.parse(context) as { experiences: typeof entry[] };
    assert.deepEqual(parsed.experiences.map(e => e.notes), [['Relevant evidence']]);
    return { ...answer(), steps };
  };
  assert.equal((await createGoal(spec, d)).status, 'planned');
});

test('failed verification replans once and repeated patches across rounds halt further work', async () => {
  const d = await fixture(); d.config.agent.maxAttempts = 1;
  let designs = 0, repairs = 0;
  d.agent!.design = async () => { designs++; return { ...answer(), steps }; };
  d.agent!.repair = async () => { repairs++; return answer([{ path: 'src/negative.ts', content: 'STILL_BROKEN' }]); };
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'needs_attention'); assert.equal(finished.completed.length, 0);
  assert.equal(finished.stepStates?.[finished.steps[0]!.id]?.status, 'rejected');
  assert.equal(finished.stepStates?.[finished.steps[1]!.id]?.status, 'blocked');
  assert.equal(designs, 2); assert.equal(repairs, 2); assert.equal(finished.reports.length, 2);
  assert.match(finished.notes.join('\n'), /Repeated patch/);
});

test('final verification cannot lose a previously completed acceptance test', async () => {
  const d = await fixture(), runner = d.runner!;
  d.runner = { run: async (files, phase, signal) => {
    const verification = await runner.run(files, phase, signal);
    if (phase === 'goal-final') verification.cases = verification.cases.filter(c => c.file !== 'test/negative.test.js');
    return verification;
  } };
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'needs_attention'); assert.equal(finished.publication, undefined);
  assert.match(finished.notes.join('\n'), /lost a completed step test/);
});

test('explicit replanning cannot rewrite previously completed steps', async () => {
  const d = await fixture(), runner = d.runner!;
  d.runner = { run: async (files, phase, signal) => {
    if (phase === 'goal-final') throw new Error('Stop before publication');
    return runner.run(files, phase, signal);
  } };
  const created = await createGoal(spec, d), first = await runGoal(created.id, d);
  assert.equal(first.completed.length, 2);
  d.agent!.design = async () => ({ ...answer(), steps: [{ ...steps[0]!, title: 'Silently revise completed work' }, steps[1]!] });
  const resumed = await runGoal(created.id, d, true);
  assert.equal(resumed.status, 'needs_attention');
  assert.match(resumed.notes.join('\n'), /cannot change completed work/);
});

test('resume consumes a durably verified active report without spending another model reservation', async () => {
  const d = await fixture(); d.config.iteration!.maxCalls = d.config.agent.maxCalls * 2;
  d.agent!.design = async () => ({ ...answer(), steps: steps.slice(0, 1) });
  const single = { ...spec, acceptance: spec.acceptance.slice(0, 1) };
  const created = await createGoal(single, d), save = d.store.save.bind(d.store);
  let crash = true;
  d.store.save = async report => {
    await save(report);
    if (crash && report.status === 'verified') { crash = false; throw new Error('Crash after verified report persisted'); }
  };
  const interrupted = await runGoal(created.id, d);
  assert.equal(interrupted.status, 'needs_attention'); assert.ok(interrupted.active);
  d.agent!.plan = async () => { assert.fail('A durably verified report must not repeat model work'); };
  const resumed = await runGoal(created.id, d);
  assert.equal(resumed.status, 'verified', resumed.notes.join('\n'));
  assert.equal(resumed.calls, interrupted.calls);
});

test('replanning cannot reset an acceptance criterion retry limit by renaming steps', async () => {
  const d = await fixture(); d.config.agent.maxAttempts = 1; d.config.iteration!.maxRounds = 2;
  let designs = 0, repairs = 0;
  d.agent!.design = async () => {
    const renamed = `negative-${designs++}`;
    return { ...answer(), steps: [{ ...steps[0]!, id: renamed }, { ...steps[1]!, dependsOn: [renamed] }] };
  };
  d.agent!.repair = async () => answer([{ path: 'src/negative.ts', content: `STILL_BROKEN_${++repairs}` }]);
  const created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  assert.equal(finished.status, 'needs_attention');
  assert.ok(repairs <= d.config.iteration!.maxRounds, `Renamed step consumed ${repairs} repairs for one criterion`);
});

test('resume restores an already published report after a crash before goal state acknowledgement', async () => {
  const d = await fixture(), created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  const published = (await d.store.read(finished.publication!))!;
  published.status = 'published'; published.pullRequestUrl = 'https://github.com/owner/repo/pull/42';
  await d.store.save(published);
  d.github.target = async () => ({ branch: 'main', sha: 'b'.repeat(40) });
  d.runner = { run: async () => { assert.fail('Already published outcome requires no new execution'); } };
  const restored = await runGoal(created.id, d);
  assert.equal(restored.status, 'published'); assert.equal(restored.pullRequestUrl, published.pullRequestUrl);
});

test('goal accounts for actual model usage above the reserved per-execution token budget', async () => {
  const d = await fixture(); d.config.iteration!.maxTokens = d.config.agent.maxTokens * 2;
  d.agent!.usage = () => ({ calls: 1, tokens: d.config.agent.maxTokens * 2 + 250 });
  const created = await createGoal(spec, d);
  assert.equal(created.tokens, 2250);
  assert.equal((await d.goals.read(created.id))!.tokens, 2250);
  d.agent!.plan = async () => { assert.fail('Overrun must prevent another model reservation'); };
  const stopped = await runGoal(created.id, d);
  assert.equal(stopped.status, 'needs_attention'); assert.match(stopped.notes.join('\n'), /budget exhausted/);
  assert.equal(stopped.tokens, 2250);
});

test('resuming a paused published goal clears pause without rerunning implementation', async () => {
  const d = await fixture(), created = await createGoal(spec, d), finished = await runGoal(created.id, d);
  const report = (await d.store.read(finished.publication!))!;
  report.status = 'published'; report.pullRequestUrl = 'https://github.com/owner/repo/pull/43';
  await d.store.save(report);
  finished.status = 'published'; finished.pullRequestUrl = report.pullRequestUrl; await d.goals.save(finished);
  await d.goals.pause(finished.id);
  d.agent!.design = async () => { assert.fail('Published goal must not repeat planning'); };
  d.runner = { run: async () => { assert.fail('Published goal must not repeat tests'); } };
  const resumed = await runGoal(finished.id, d);
  assert.equal(resumed.status, 'published'); assert.equal(await d.goals.paused(finished.id), false);
});

test('pausing during initial goal design aborts the active agent call', async () => {
  const d = await fixture(); let aborted = false;
  d.agent!.design = async (_base, _context, signal) => {
    const current = (await d.goals.list())[0]!;
    await d.goals.pause(current.id);
    assert.ok(signal);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Pause did not abort active design')), 2000);
      signal.addEventListener('abort', () => { clearTimeout(timeout); aborted = true; resolve(); }, { once: true });
    });
    signal.throwIfAborted();
    return { ...answer(), steps };
  };
  const created = await createGoal(spec, d);
  assert.equal(aborted, true); assert.equal(created.status, 'paused');
  assert.equal(created.activeSince, undefined); assert.equal(await d.goals.paused(created.id), true);
});

test('incomplete usage keeps unknown token reservation and records any known excess', async () => {
  for (const tokens of [0, 250, 1250]) {
    const d = await fixture(); d.config.iteration!.maxTokens = d.config.agent.maxTokens;
    d.agent!.usage = () => ({ calls: 1, tokens, complete: false });
    const created = await createGoal(spec, d), expected = Math.max(tokens, d.config.agent.maxTokens);
    assert.equal(created.tokens, expected); assert.equal(created.calls, 1);
    assert.equal((await d.goals.read(created.id))!.tokens, expected);
    d.agent!.plan = async () => { assert.fail('Unknown token usage cannot release a new execution budget'); };
    const stopped = await runGoal(created.id, d);
    assert.equal(stopped.status, 'needs_attention'); assert.equal(stopped.tokens, expected);
    assert.match(stopped.notes.join('\n'), /budget exhausted/);
  }
});
