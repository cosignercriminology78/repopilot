#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { resolveCommit, snapshot } from './git.js';
import { DockerRunner } from './runner.js';
import { DockerCodexAgent } from './agent.js';
import { runPipeline, descriptionHash } from './pipeline.js';
import { withFreshness } from './control.js';
import { finishReport } from './publication.js';
import { GitHub } from './github.js';
import { checked } from './process.js';
import type { Report } from './types.js';
import { taskSummary, requireTask, replayTask } from './tasks.js';
import { markdownReport } from './report.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
  once: { type: 'boolean' }, help: { type: 'boolean' }, format: { type: 'string' },
  status: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }
} });
const command = positionals[0];
if (values.help || !command) {
  console.log(`RepoPilot 0.1 — local-first repository verification

  npm run dev -- check --config config.local.json --repo /path/to/repo --base main --head feature
  npm run dev -- watch --config config.local.json [--once]
  npm run dev -- tasks list --config config.local.json [--status running] [--limit 20] [--offset 0]
  npm run dev -- tasks show TASK_ID --config config.local.json [--format json|markdown]
  npm run dev -- tasks cancel TASK_ID --config config.local.json
  npm run dev -- tasks resume TASK_ID --config config.local.json
  npm run dev -- tasks rerun TASK_ID --config config.local.json

check: verify local commit snapshots without modifying the source repository.
watch: poll GitHub PRs; persist reports; optionally publish verified repair branches.
Configuration lives outside tested snapshots. See README.md for Docker and authentication setup.`);
} else {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
async function main() {
  if (!values.config || !['check', 'watch', 'tasks'].includes(command!)) throw new Error('Use check, watch or tasks with --config.');
  const config = await loadConfig(values.config);
  const store = new Store(config.dataDir);
  const action = positionals[1], task = positionals[2];
  if (command === 'tasks') {
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
      console.log(JSON.stringify({ total: reports.length, offset, tasks }, null, 2)); return;
    }
    const report = await requireTask(store, task!);
    if (report.repository !== config.repository) throw new Error('Task repository does not match configuration.');
    if (action === 'show') {
      if (values.format && !['json', 'markdown'].includes(values.format)) throw new Error('Unknown report format.');
      console.log(values.format === 'markdown' ? markdownReport(report) : JSON.stringify({ ...report,
        cancellationRequested: await store.cancellationRequested(report.id) }, null, 2)); return;
    }
    if (action === 'cancel') {
      await store.requestCancellation(task!);
      console.log(JSON.stringify({ id: task, cancellationRequested: true })); return;
    }
  }
  const release = await store.acquire();
  const runner = config.runner ? new DockerRunner(config.runner, config.dataDir) : undefined;
  const agent = config.agent.enabled ? new DockerCodexAgent(config.agent, config.dataDir) : undefined;
  const abort = new AbortController();
  const github = new GitHub(config.repository, undefined, { signal: abort.signal, retry: config.retry });
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'tasks') {
      const report = await replayTask(task!, action as 'resume' | 'rerun', config, store, runner, agent, abort.signal, github);
      if (report.pr) await finishReport(report, config, store, github, abort.signal);
      print(report); process.exitCode = ['passed', 'verified', 'published'].includes(report.status) ? 0 : 2;
      return;
    }
    if (command === 'check') {
      if (!values.repo || !values.base || !values.head) throw new Error('check requires --repo, --base and --head.');
      const repo = resolve(values.repo);
      const baseSha = await resolveCommit(repo, values.base), headSha = await resolveCommit(repo, values.head);
      const report = await runPipeline({ base: await snapshot(repo, baseSha, abort.signal), head: await snapshot(repo, headSha, abort.signal), baseSha, headSha, repoPath: repo }, config, store, runner, agent, abort.signal);
      print(report); process.exitCode = ['passed', 'verified'].includes(report.status) ? 0 : 2;
      return;
    }
    const cache = resolve(config.dataDir, 'git-cache');
    if (!await stat(cache).catch(() => undefined)) { await mkdir(cache); await checked('git', ['init', '--bare', cache]); }
    do {
      const pulls = await github.listPulls();
      for (const summary of pulls) {
        if (abort.signal.aborted) break;
        if (summary.draft || summary.head.repo?.full_name !== config.repository || summary.head.ref.startsWith('autofix/')) continue;
        try {
          const pr = await github.pull(summary.number);
          if (pr.state !== 'open' || pr.draft || pr.head.ref.startsWith('autofix/') || pr.head.repo?.full_name !== config.repository) continue;
          const report = await withFreshness(async signal => {
            await checked('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags',
              `https://github.com/${config.repository}.git`, pr.base.sha, pr.head.sha], cache, signal);
            return runPipeline({ base: await snapshot(cache, pr.base.sha, signal), head: await snapshot(cache, pr.head.sha, signal),
              baseSha: pr.base.sha, headSha: pr.head.sha, repoPath: cache, pr, description: `${pr.title}\n${pr.body ?? ''}` }, config, store, runner, agent, signal);
          }, async () => {
            const latest = await github.pull(pr.number);
            return latest.state === 'open' && !latest.draft && latest.head.repo?.full_name === config.repository
              && latest.head.sha === pr.head.sha && latest.base.sha === pr.base.sha && descriptionHash(latest) === descriptionHash(pr);
          }, config.freshnessSeconds * 1000, abort.signal);
          await finishReport(report, config, store, github, abort.signal); print(report);
        } catch (error) { console.error(`PR #${summary.number}: ${String(error)}`); }
      }
      if (!values.once && !abort.signal.aborted) await sleep(config.pollSeconds * 1000, undefined, { signal: abort.signal }).catch(() => undefined);
    } while (!values.once && !abort.signal.aborted);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await release(); }

  function print(report: Report) {
    console.log(JSON.stringify({ id: report.id, status: report.status, findings: report.findings.length,
      tests: report.tests.head.status, semantic: report.semantic,
      report: resolve(config.dataDir, `${report.id}.json`), pullRequest: report.pullRequestUrl }));
  }
}
