import { resolve } from 'node:path';
import { runPipeline } from '../../application/pipeline.js';
import type { CliValues } from '../args.js';
import type { Runtime } from '../runtime.js';
export async function check(values: CliValues, runtime: Runtime) {
  if (!values.repo || !values.base || !values.head) throw new Error('check requires --repo, --base and --head.');
  const { repository, config, store, runner, agent, signal } = runtime;
  const repo = resolve(values.repo);
  const baseSha = await repository.resolveCommit(repo, values.base), headSha = await repository.resolveCommit(repo, values.head);
  return runPipeline({ base: await repository.snapshot(repo, baseSha, signal),
    head: await repository.snapshot(repo, headSha, signal), baseSha, headSha, repoPath: repo },
    config, store, runner, agent, signal);
}
