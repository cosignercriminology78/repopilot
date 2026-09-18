import type { Store } from '../ports/store.js';
import { pause } from '../shared/control.js';
export class TaskCancelledError extends Error {
  constructor() { super('Task cancelled by operator.'); }
}
/** Cancellation requests do not acquire the writer lock or mutate running reports. */
export async function withTaskCancellation<T>(store: Store, id: string, work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal, intervalMs = 250): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const inspect = async () => {
    if (await store.cancellationRequested(id)) controller.abort(new TaskCancelledError());
  };
  await inspect();
  const monitor = (async () => {
    while (!signal.aborted) {
      try { await pause(intervalMs, signal); await inspect(); }
      catch (error) { if (!signal.aborted) controller.abort(error); }
    }
  })();
  try { return await work(signal); }
  finally { controller.abort(); await monitor; }
}
