import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControllerLock } from '../src/adapters/storage/controller-lock.js';
import { DockerRecoveryResources } from '../src/adapters/testing/recovery-resources.js';
import { applyRecovery, recoveryPreview } from '../src/application/recovery.js';
import type { OwnedResource, RecoveryResources } from '../src/ports/recovery.js';
import { resourceOwner } from '../src/shared/resource-owner.js';
import { store, verifiedReport } from './helpers.js';

const empty: RecoveryResources = { list: async () => [], remove: async () => { throw new Error('Unexpected removal'); } };
const record = { schemaVersion: 1, hostname: hostname(), owner: 'fixture', pid: 99999, startedAt: new Date().toISOString() };
const resource: OwnedResource = { kind: 'container', id: 'b'.repeat(64), name: 'repopilot-test-00000000-0000-0000-0000-000000000000-command-default' };

test('locks fail closed for live, unknown, legacy and foreign hosts', async () => {
  const saved = await store(), path = join(saved.root, 'controller.lock');
  for (const [data, alive, expected] of [
    [record, true, 'active'], [record, undefined, 'unknown'], [{ pid: 99999 }, false, 'unknown'],
    [{ ...record, hostname: 'another-host' }, false, 'unknown'], [{ ...record, pid: -1 }, false, 'unknown']
  ] as const) {
    await writeFile(path, JSON.stringify(data));
    const lock = new ControllerLock(saved.root, () => alive), state = await lock.inspect();
    assert.equal(state.status, expected); await assert.rejects(lock.acquire(state.fingerprint), /not safely recoverable/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
  }
  await writeFile(path, '{incomplete');
  assert.equal((await new ControllerLock(saved.root).inspect()).status, 'unknown');
});

test('stale lock takeover rechecks fingerprint and release checks ownership', async () => {
  const saved = await store(), path = join(saved.root, 'controller.lock');
  await writeFile(path, JSON.stringify(record));
  const lock = new ControllerLock(saved.root, pid => pid === process.pid), before = await lock.inspect();
  assert.equal(before.status, 'stale');
  await assert.rejects(lock.acquire('outdated'), /changed/);
  const release = await lock.acquire(before.fingerprint);
  assert.equal((await lock.inspect()).status, 'active');
  const replacement = { ...record, owner: 'replacement', pid: process.pid };
  await writeFile(path, JSON.stringify(replacement));
  await assert.rejects(release(), /ownership changed/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement);
});

test('concurrent controller acquisition has only one owner', async () => {
  const saved = await store();
  const outcomes = await Promise.allSettled([saved.acquire(), saved.acquire()]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  for (const outcome of outcomes) if (outcome.status === 'fulfilled') await outcome.value();
  assert.equal((await new ControllerLock(saved.root).inspect()).status, 'absent');
});

test('preview is non-destructive and apply preserves evidence while pausing interrupted tasks', async () => {
  const saved = await store(), report = { ...verifiedReport(), status: 'running' as const };
  await saved.save(report);
  const lock = new ControllerLock(saved.root), removed: string[] = [];
  const resources: RecoveryResources = { list: async () => removed.length ? [] : [resource], remove: async r => { removed.push(r.id); } };
  const preview = await recoveryPreview(report.repository, saved, lock, resources);
  assert.equal(preview.applicable, true); assert.equal(removed.length, 0);
  assert.equal((await saved.read(report.id))?.status, 'running');
  const result = await applyRecovery(report.repository, preview.token, saved, lock, resources);
  assert.deepEqual(result.recovered, [report.id]); assert.deepEqual(removed, [resource.id]);
  const recovered = await saved.read(report.id);
  assert.equal(recovered?.status, 'cancelled'); assert.deepEqual(recovered?.tests, report.tests);
  assert.equal(await saved.cancellationRequested(report.id), true);
  assert.equal(JSON.parse(await readFile(join(saved.root, report.id + '.execution-' + report.executions + '.json'), 'utf8')).status, 'running');
  assert.equal((await lock.inspect()).status, 'absent');
});

test('changed previews and active controllers prevent resource deletion', async () => {
  const saved = await store(), lock = new ControllerLock(saved.root);
  const preview = await recoveryPreview('owner/repo', saved, lock, empty);
  const release = await saved.acquire();
  await assert.rejects(applyRecovery('owner/repo', preview.token, saved, lock, empty), /changed|active/);
  await release();
  await saved.save({ ...verifiedReport(), status: 'running' });
  await assert.rejects(applyRecovery('owner/repo', preview.token, saved, lock, empty), /changed/);
});

test('resource changes after locking block cleanup; failures retain interrupted reports', async () => {
  const saved = await store(), lock = new ControllerLock(saved.root);
  const report = { ...verifiedReport(), status: 'running' as const }; await saved.save(report);
  let calls = 0;
  const changing: RecoveryResources = { list: async () => ++calls <= 2 ? [] : [resource], remove: empty.remove };
  const preview = await recoveryPreview(report.repository, saved, lock, changing);
  await assert.rejects(applyRecovery(report.repository, preview.token, saved, lock, changing), /changed/);
  const failed: RecoveryResources = { list: async () => [resource], remove: async () => { throw new Error('removal failed'); } };
  const next = await recoveryPreview(report.repository, saved, lock, failed);
  const result = await applyRecovery(report.repository, next.token, saved, lock, failed);
  assert.ok(result.errors.length >= 1); assert.equal((await saved.read(report.id))?.status, 'running');
  assert.equal((await lock.inspect()).status, 'absent');
});

test('Docker cleanup filters ownership and rechecks labels before removing exact IDs', async () => {
  const saved = await store(), owner = await resourceOwner(saved.root), calls: string[][] = [];
  let changed = false;
  const adapter = new DockerRecoveryResources(saved.root, async (_binary, args) => {
    calls.push(args);
    const row = { Id: resource.id, Name: '/' + resource.name,
      Config: { Labels: { 'io.repopilot.managed': 'true', 'io.repopilot.owner': changed ? 'other-directory' : owner } } };
    return { code: 0, timedOut: false, stderr: '', stdout: args[1] === 'ls' ? (args[0] === 'container' ? resource.id : '')
      : args[1] === 'inspect' ? JSON.stringify([row]) : '' };
  });
  assert.deepEqual(await adapter.list(), [resource]);
  assert.ok(calls.filter(c => c[1] === 'ls').every(c => c.includes('label=io.repopilot.owner=' + owner)));
  changed = true;
  await assert.rejects(adapter.remove(resource), /ownership/);
  assert.ok(!calls.some(c => c[1] === 'rm'));
  changed = false; await adapter.remove(resource);
  assert.deepEqual(calls.at(-1), ['container', 'rm', '-f', '-v', resource.id]);
  assert.notEqual(owner, await resourceOwner((await store()).root));
});
