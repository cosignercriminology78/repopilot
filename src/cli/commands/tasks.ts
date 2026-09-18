import { finishReport } from '../../application/publication.js';
import { replayTask, requireTask, taskSummary } from '../../application/tasks.js';
import type { Config } from '../../domain/config.js';
import type { Store } from '../../ports/store.js';
import { markdownReport } from '../../reporting/markdown.js';
import type { CliValues } from '../args.js';
import type { Output, Runtime } from '../runtime.js';
export async function inspectTasks(action: string | undefined, task: string | undefined, values: CliValues,
  config: Config, store: Store, output: Output): Promise<boolean> {
  if (!['list', 'show', 'cancel', 'resume', 'rerun'].includes(action ?? '')) throw new Error('Unknown tasks action.');
  if (action !== 'list' && !task) throw new Error('Task ID is required.');
  if (action === 'list') {
    const limit = Number(values.limit ?? 20), offset = Number(values.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid pagination.');
    const statuses = ['running', 'passed', 'needs_attention', 'verified', 'published', 'stale', 'cancelled', 'error'];
    if (values.status && !statuses.includes(values.status)) throw new Error('Unknown task status.');
    const reports = (await store.list()).filter(r => r.repository === config.repository && (!values.status || r.status === values.status));
    const tasks = [];
    for (const r of reports.slice(offset, offset + limit)) tasks.push({ ...taskSummary(r), cancellationRequested: await store.cancellationRequested(r.id) });
    output.write(JSON.stringify({ total: reports.length, offset, tasks }, null, 2)); return true;
  }
  const report = await requireTask(store, task!);
  if (report.repository !== config.repository) throw new Error('Task repository does not match configuration.');
  if (action === 'show') {
    if (values.format && !['json', 'markdown'].includes(values.format)) throw new Error('Unknown report format.');
    output.write(values.format === 'markdown' ? markdownReport(report) : JSON.stringify({ ...report,
      cancellationRequested: await store.cancellationRequested(report.id) }, null, 2)); return true;
  }
  if (action === 'cancel') {
    await store.requestCancellation(task!);
    output.write(JSON.stringify({ id: task, cancellationRequested: true })); return true;
  }
  return false;
}
export async function runTask(action: string, task: string, runtime: Runtime) {
  if (action !== 'resume' && action !== 'rerun') throw new Error('Unknown task execution action.');
  const { config, store, repository, github, runner, agent, signal } = runtime;
  const report = await replayTask(task, action, config, store, repository, github, runner, agent, signal);
  if (report.pr || report.issue) await finishReport(report, config, store, github, signal);
  return report;
}
