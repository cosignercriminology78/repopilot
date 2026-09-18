import { resolve } from 'node:path';
import type { WatchDependencies } from './watch.js';
import type { IssueGitHub } from '../ports/github.js';
import { withFreshness } from '../shared/control.js';
import { runPipeline } from './pipeline.js';
import { finishReport } from './publication.js';

export async function fixIssue(number: number, branch: string | undefined, deps: WatchDependencies & { github: WatchDependencies['github'] & IssueGitHub }) {
  const { github, repository, store, config, agent, runner, signal } = deps;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Issue number must be a positive integer.');
  if (!agent || !runner || !config.agent.repair) throw new Error('Issue repair requires agent.enabled, agent.repair and a runner.');
  const issue = await github.issue(number), target = await github.target(branch);
  if (issue.pull_request || issue.state !== 'open') throw new Error('Select an open Issue, not a pull request.');
  const source = { number, title: issue.title, body: issue.body ?? '', branch: target.branch };
  const description = source.title + '\n' + source.body;
  const cache = resolve(config.dataDir, 'git-cache'); await repository.prepare(cache);
  const report = await withFreshness(async controlled => {
    await repository.fetch(cache, config.repository, target.sha, target.sha, controlled);
    const snapshot = await repository.snapshot(cache, target.sha, controlled);
    return runPipeline({ base: snapshot, head: snapshot, baseSha: target.sha, headSha: target.sha,
      issue: source, description, repoPath: cache }, config, store, runner, agent, controlled);
  }, async () => {
    const current = await github.issue(number), latest = await github.target(target.branch);
    return !current.pull_request && current.state === 'open' && current.title === source.title && (current.body ?? '') === source.body && latest.sha === target.sha;
  }, config.freshnessSeconds * 1000, signal);
  await finishReport(report, config, store, github, signal); return report;
}
