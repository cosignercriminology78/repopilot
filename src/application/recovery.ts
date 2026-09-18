import { createHash } from 'node:crypto';
import type { RecoveryLock, RecoveryResources } from '../ports/recovery.js';
import type { Store } from '../ports/store.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function recoveryPreview(repository: string, store: Store, lock: RecoveryLock, resources: RecoveryResources) {
  const state = await lock.inspect();
  const tasks = (await store.list()).filter(r => r.repository === repository && r.status === 'running')
    .map(r => ({ id: r.id, executions: r.executions, fingerprint: fingerprint(r) })).sort((a, b) => a.id.localeCompare(b.id));
  const owned = await resources.list();
  const content = { repository, lock: state, tasks, resources: owned };
  return { ...content, applicable: ['absent', 'stale'].includes(state.status), token: fingerprint(content) };
}

export async function applyRecovery(repository: string, token: string, store: Store, lock: RecoveryLock, resources: RecoveryResources) {
  const preview = await recoveryPreview(repository, store, lock, resources);
  if (!preview.applicable || token !== preview.token) throw new Error('Recovery preview changed or controller is active/unknown; inspect again.');
  const release = await lock.acquire(preview.lock.fingerprint);
  try {
    const current = await recoveryPreview(repository, store, lock, resources);
    if (fingerprint(current.tasks) !== fingerprint(preview.tasks) || fingerprint(current.resources) !== fingerprint(preview.resources)) {
      throw new Error('Recovery resources or tasks changed; inspect again.');
    }
    const removed: string[] = [], errors: string[] = [], recovered: string[] = [];
    for (const resource of preview.resources) {
      try { await resources.remove(resource); removed.push(resource.id); }
      catch (error) { errors.push(String(error)); }
    }
    if ((await resources.list()).length) errors.push('Owned Docker resources remain; inspect recovery again.');
    if (!errors.length) {
      for (const task of preview.tasks) {
        const report = await store.read(task.id);
        if (!report || fingerprint(report) !== task.fingerprint) throw new Error('Task changed during recovery.');
        await store.archive(report);
        await store.requestCancellation(report.id);
        report.status = 'cancelled'; report.retryable = false;
        report.notes.push('Interrupted task recovered by operator. Evidence retained; use tasks resume or rerun.');
        await store.save(report); recovered.push(report.id);
      }
    }
    return { removed, recovered, errors };
  } finally { await release(); }
}
