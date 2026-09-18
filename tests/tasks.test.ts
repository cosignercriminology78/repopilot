import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../src/adapters/github/client.js';
import { runPipeline } from '../src/application/pipeline.js';
import { finishReport } from '../src/application/publication.js';
import { replayInput } from '../src/application/tasks.js';
import { configSchema } from '../src/domain/config.js';
import { pipelineId } from '../src/domain/identity.js';
import { pr, result, store, verifiedReport } from './helpers.js';

const config = configSchema.parse({ repository: 'owner/repo' });
const input = { base: new Map([['a.ts', 'before']]), head: new Map([['a.ts', 'after']]),
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), repoPath: '/fixture', description: 'change' };
test('listing excludes execution archives and cancellation requests', async () => {
  const saved = await store(), r = verifiedReport();
  await saved.save(r); await saved.archive(r); await saved.requestCancellation(r.id);
  assert.equal((await saved.list()).length, 1);
  assert.equal(await saved.cancellationRequested(r.id), true);
  assert.equal((await saved.read(r.id))?.status, 'verified');
});
test('cancellation interrupts running work and persists until explicit resume', async () => {
  const saved = await store(), id = pipelineId(input, config);
  const runner = { run: async (_files: unknown, _label: string, signal?: AbortSignal) => {
    await saved.requestCancellation(id); signal!.throwIfAborted();
    return new Promise<ReturnType<typeof result>>((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  } };
  const r = await runPipeline(input, config, saved, runner, undefined, AbortSignal.timeout(3000));
  assert.equal(r.status, 'cancelled');
  const again = await runPipeline(input, config, saved, { run: async () => { throw new Error('must not rerun'); } });
  assert.equal(again.executions, 1); assert.equal(again.status, 'cancelled');
  await saved.clearCancellation(id);
  const resumed = await runPipeline(input, config, saved, { run: async () => result() });
  assert.equal(resumed.status, 'passed'); assert.equal(resumed.executions, 2);
});
test('resume preserves identity/budget and rerun creates a linked distinct task', () => {
  const report = { ...verifiedReport(), id: pipelineId(input, config), status: 'cancelled' as const,
    base: input.baseSha, head: input.headSha, replay: { repoPath: input.repoPath, description: input.description } };
  assert.equal(pipelineId(replayInput(report, config, 'resume'), config), report.id);
  const rerun = replayInput(report, config, 'rerun');
  assert.notEqual(pipelineId(rerun, config), report.id); assert.equal(rerun.rerunOf, report.id);
  assert.equal(rerun.baseSha, report.base); assert.equal(rerun.headSha, report.head);
  assert.throws(() => replayInput({ ...report, executions: config.retry.maxTaskExecutions }, config, 'resume'), /limit/);
  assert.throws(() => replayInput(report, { ...config, taskTimeoutSeconds: 300 }, 'resume'), /Configuration changed/);
  assert.throws(() => replayInput({ ...report, status: 'error', retryable: false }, config, 'resume'), /Permanent/);
  assert.throws(() => replayInput({ ...report, replay: undefined }, config, 'rerun'), /metadata/);
  const publishConfig = { ...config, publish: true };
  assert.throws(() => replayInput({ ...report, id: pipelineId(input, publishConfig), status: 'verified',
    publication: { attempts: 3, retryable: true } }, publishConfig, 'resume'), /Publication cannot resume/);
});
test('read and cancel remain available while controller owns writer lock', async () => {
  const saved = await store(), r = verifiedReport(); await saved.save(r);
  const release = await saved.acquire();
  try {
    await saved.requestCancellation(r.id);
    assert.equal((await saved.list()).length, 1);
    await assert.rejects(saved.acquire(), /lock exists/);
  } finally { await release(); }
});
test('cancellation before publication prevents GitHub writes', async () => {
  const saved = await store(), r = verifiedReport(); await saved.save(r); await saved.requestCancellation(r.id);
  await finishReport(r, { ...config, publish: true }, saved, {
    current: async () => { throw new Error('must not reach GitHub'); },
    publish: async () => { throw new Error('must not publish'); }
  });
  assert.equal(r.status, 'cancelled');
});
test('published tasks cannot be cancelled and task identifiers are confined', async () => {
  const saved = await store(), r = { ...verifiedReport(), status: 'published' as const }; await saved.save(r);
  await assert.rejects(saved.requestCancellation(r.id), /Published/);
  await assert.rejects(saved.requestCancellation('../controller.lock'), /Invalid/);
  await assert.rejects(saved.clearCancellation('../controller.lock'), /Invalid/);
});
test('cancellation reaches the active publication request', async () => {
  const saved = await store(), r = verifiedReport(); await saved.save(r);
  let calls = 0;
  const github = new GitHub('owner/repo', 'fixture', { transport: async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(pr));
    await saved.requestCancellation(r.id);
    const signal = options!.signal!;
    signal.throwIfAborted();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await finishReport(r, { ...config, publish: true }, saved, github, AbortSignal.timeout(3000));
  assert.equal(r.status, 'cancelled'); assert.equal(calls, 2);
});
