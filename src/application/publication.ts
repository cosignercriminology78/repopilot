import type { Config } from '../domain/config.js';
import type { Report } from '../domain/types.js';
import type { GitHub } from '../ports/github.js';
import type { Store } from '../ports/store.js';
import { RetryableError } from '../shared/control.js';
import { TaskCancelledError, withTaskCancellation } from './task-control.js';
/** Persist intent before any write, so crash recovery consumes the same bounded budget. */
export async function finishReport(report: Report, config: Config, store: Store,
  github: Pick<GitHub, 'current' | 'publish'>, signal?: AbortSignal): Promise<void> {
  return withTaskCancellation(store, report.id, controlled => finish(report, config, store, github, controlled), signal);
}
async function finish(report: Report, config: Config, store: Store,
  github: Pick<GitHub, 'current' | 'publish'>, signal: AbortSignal): Promise<void> {
  if (report.status === 'published' || report.status === 'stale') return;
  if (signal.reason instanceof TaskCancelledError || report.status === 'cancelled') {
    report.status = 'cancelled'; await store.save(report); return;
  }
  if (!await github.current(report)) report.status = 'stale';
  else if (config.publish && report.status === 'verified') {
    const prior = report.publication;
    if (prior && (!prior.retryable || prior.attempts >= config.retry.maxTaskExecutions
      || Date.parse(prior.retryAfter ?? '') > Date.now())) return;
    report.publication = { attempts: (prior?.attempts ?? 0) + 1, retryable: true };
    await store.save(report);
    try {
      signal.throwIfAborted();
      const url = await github.publish(report, signal);
      if (url) { report.pullRequestUrl = url; report.status = 'published'; report.publication.retryable = false; }
      else report.status = 'stale';
    } catch (error) {
      if (signal.reason instanceof TaskCancelledError) report.status = 'cancelled';
      report.publication.error = String(error);
      report.publication.retryable = error instanceof RetryableError || !!signal?.aborted;
      report.publication.retryAfter = new Date(Date.now() + Math.max(error instanceof RetryableError ? error.retryAfterMs : 0,
        Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (report.publication.attempts - 1)))).toISOString();
      report.notes.push('Publication: ' + String(error));
    }
  }
  await store.save(report);
}
