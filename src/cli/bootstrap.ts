import { DockerCodexAgent } from '../adapters/codex/docker-agent.js';
import { GitHub } from '../adapters/github/client.js';
import { Store } from '../adapters/storage/file-store.js';
import { gitRepository } from '../adapters/storage/repository.js';
import { DockerRunner } from '../adapters/testing/docker-runner.js';
import { describeTestEnvironment } from '../domain/runner-config.js';
import { help, parseCli } from './args.js';
import { check } from './commands/check.js';
import { inspectTasks, runTask } from './commands/tasks.js';
import { watchCommand } from './commands/watch.js';
import { loadConfig } from './config.js';
import { reportExitCode, reportSummary } from './output.js';
import type { Output, Runtime } from './runtime.js';
const standardOutput: Output = { write: value => console.log(value), error: value => console.error(value) };
export async function main(args: string[], output: Output = standardOutput): Promise<number> {
  const { positionals, values } = parseCli(args);
  const command = positionals[0];
  if (values.help || !command) { output.write(help); return 0; }
  if (!values.config || !['check', 'watch', 'tasks'].includes(command)) throw new Error('Use check, watch or tasks with --config.');
  const config = await loadConfig(values.config), store = new Store(config.dataDir);
  const action = positionals[1], task = positionals[2];
  if (command === 'tasks' && await inspectTasks(action, task, values, config, store, output)) return 0;
  const release = await store.acquire();
  const abort = new AbortController(), stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const runtime: Runtime = { config, store, repository: gitRepository, signal: abort.signal,
      runner: config.runner ? new DockerRunner(config.runner, config.dataDir) : undefined,
      agent: config.agent.enabled ? new DockerCodexAgent(config.agent, config.dataDir,
        config.runner ? describeTestEnvironment(config.runner) : undefined) : undefined,
      github: new GitHub(config.repository, undefined, { signal: abort.signal, retry: config.retry }) };
    if (command === 'watch') { await watchCommand(values, runtime, output); return 0; }
    const report = command === 'check' ? await check(values, runtime) : await runTask(action!, task!, runtime);
    output.write(reportSummary(report, config)); return reportExitCode(report);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await release(); }
}
