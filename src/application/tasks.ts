import { randomUUID } from 'node:crypto';
import type { Config } from '../domain/config.js';
import { pipelineId } from '../domain/identity.js';
import { type RunInput } from '../domain/task.js';
import type { Report } from '../domain/types.js';
import type { Agent } from '../ports/agent.js';
import type { GitHub } from '../ports/github.js';
import type { Repository } from '../ports/repository.js';
import type { Runner } from '../ports/runner.js';
import type { Store } from '../ports/store.js';
import { withFreshness } from '../shared/control.js';
import { runPipeline } from './pipeline.js';

export function taskSummary(report: Report) {
  return { id: report.id, status: report.status, repository: report.repository, pr: report.pr,
    createdAt: report.createdAt, executions: report.executions, attempts: report.attempts,
    rerunOf: report.rerunOf, replayable: !!report.replay, pullRequestUrl: report.pullRequestUrl };
}
export async function requireTask(store: Store, id: string): Promise<Report> {
  const report = await store.read(id);
  if (!report) throw new Error('Task not found: ' + id);
  return report;
}
export function replayInput(report: Report, config: Config, mode: 'resume' | 'rerun'): Omit<RunInput, 'base' | 'head'> & { repoPath: string } {
  if (report.repository !== config.repository) throw new Error('Task repository does not match configuration.');
  if (!report.replay) throw new Error('Task has no replay metadata; run check/watch again to record its source.');
  const input = { ...report.replay, baseSha: report.base, headSha: report.head, rerunOf: report.rerunOf };
  if (mode === 'resume') {
    if (!['running', 'cancelled', 'error', 'verified'].includes(report.status)) throw new Error('Task is terminal; use tasks rerun.');
    if (pipelineId(input, config) !== report.id) throw new Error('Configuration changed; use tasks rerun to create a new task.');
    if (report.status !== 'verified' && report.executions >= config.retry.maxTaskExecutions) throw new Error('Task execution limit reached; use tasks rerun.');
    if (report.status === 'error' && !report.retryable) throw new Error('Permanent failure; correct the cause and use tasks rerun.');
    if (report.retryAfter && Date.parse(report.retryAfter) > Date.now()) throw new Error('Retry is deferred until ' + report.retryAfter);
    if (report.status === 'verified' && config.publish && report.publication) {
      if (!report.publication.retryable || report.publication.attempts >= config.retry.maxTaskExecutions) {
        throw new Error('Publication cannot resume; correct the cause and use tasks rerun.');
      }
      if (report.publication.retryAfter && Date.parse(report.publication.retryAfter) > Date.now()) {
        throw new Error('Publication retry is deferred until ' + report.publication.retryAfter);
      }
    }
  } else { input.runKey = randomUUID(); input.rerunOf = report.id; }
  return input;
}
/** Caller holds the controller lock. Replays pinned commits, never a moving branch name. */
export async function replayTask(id: string, mode: 'resume' | 'rerun', config: Config, store: Store,
  repository: Repository, github: Pick<GitHub, 'current'>, runner?: Runner, agent?: Agent, signal?: AbortSignal): Promise<Report> {
  const previous = await requireTask(store, id);
  const input = replayInput(previous, config, mode);
  const work = async (controlled?: AbortSignal) => {
    if (mode === 'resume') await store.clearCancellation(id);
    if (mode === 'resume' && previous.status === 'verified') {
      return previous;
    }
    const base = await repository.snapshot(input.repoPath, input.baseSha, controlled);
    const head = await repository.snapshot(input.repoPath, input.headSha, controlled);
    return runPipeline({ ...input, base, head }, config, store, runner, agent, controlled);
  };
  if (!previous.pr) return work(signal);
  if (!await github.current(previous)) throw new Error('PR inputs changed; use watch to review the current revision.');
  return withFreshness(work, async () => !!await github.current(previous), config.freshnessSeconds * 1000, signal);
}
