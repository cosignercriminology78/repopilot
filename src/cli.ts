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
import { runPipeline } from './pipeline.js';
import { GitHub } from './github.js';
import { checked } from './process.js';
import type { PullRequest, Report } from './types.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
  once: { type: 'boolean' }, help: { type: 'boolean' }
} });
const command = positionals[0];
if (values.help || !command) {
  console.log(`RepoPilot 0.1 — local-first repository verification

  npm run dev -- check --config config.local.json --repo /path/to/repo --base main --head feature
  npm run dev -- watch --config config.local.json [--once]

check: verify local commit snapshots without modifying the source repository.
watch: poll GitHub PRs; persist reports; optionally publish verified repair branches.
Configuration lives outside tested snapshots. See README.md for Docker and authentication setup.`);
} else {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
async function main() {
  if (!values.config || !['check', 'watch'].includes(command!)) throw new Error('Use check or watch with --config.');
  const config = await loadConfig(values.config);
  const store = new Store(config.dataDir), release = await store.acquire();
  const runner = config.runner ? new DockerRunner(config.runner, config.dataDir) : undefined;
  const agent = config.agent.enabled ? new DockerCodexAgent(config.agent, config.dataDir) : undefined;
  const github = new GitHub(config.repository);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'check') {
      if (!values.repo || !values.base || !values.head) throw new Error('check requires --repo, --base and --head.');
      const repo = resolve(values.repo);
      const baseSha = await resolveCommit(repo, values.base), headSha = await resolveCommit(repo, values.head);
      const report = await runPipeline({ base: await snapshot(repo, baseSha), head: await snapshot(repo, headSha), baseSha, headSha }, config, store, runner, agent);
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
          if (pr.state !== 'open' || pr.head.repo?.full_name !== config.repository) continue;
          await checked('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags',
            `https://github.com/${config.repository}.git`, pr.base.sha, pr.head.sha], cache);
          const report = await runPipeline({ base: await snapshot(cache, pr.base.sha), head: await snapshot(cache, pr.head.sha),
            baseSha: pr.base.sha, headSha: pr.head.sha, pr, description: `${pr.title}\n${pr.body ?? ''}` }, config, store, runner, agent);
          await finish(report, pr); print(report);
        } catch (error) { console.error(`PR #${summary.number}: ${String(error)}`); }
      }
      if (!values.once && !abort.signal.aborted) await sleep(config.pollSeconds * 1000, undefined, { signal: abort.signal }).catch(() => undefined);
    } while (!values.once && !abort.signal.aborted);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await release(); }

  async function finish(report: Report, _pr: PullRequest) {
    if (report.status === 'published' || report.status === 'stale') return;
    if (!await github.current(report)) report.status = 'stale';
    else if (config.publish && report.status === 'verified') {
      const url = await github.publish(report);
      if (url) { report.pullRequestUrl = url; report.status = 'published'; }
      else report.status = 'stale';
    }
    await store.save(report);
  }
  function print(report: Report) {
    console.log(JSON.stringify({ id: report.id, status: report.status, findings: report.findings.length,
      tests: report.tests.head.status, semantic: report.semantic,
      report: resolve(config.dataDir, `${report.id}.json`), pullRequest: report.pullRequestUrl }));
  }
}
