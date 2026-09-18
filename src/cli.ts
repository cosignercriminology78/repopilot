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
  const abort = new AbortController();
  const github = new GitHub(config.repository, undefined, { signal: abort.signal, retry: config.retry });
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'check') {
      if (!values.repo || !values.base || !values.head) throw new Error('check requires --repo, --base and --head.');
      const repo = resolve(values.repo);
      const baseSha = await resolveCommit(repo, values.base), headSha = await resolveCommit(repo, values.head);
      const report = await runPipeline({ base: await snapshot(repo, baseSha, abort.signal), head: await snapshot(repo, headSha, abort.signal), baseSha, headSha }, config, store, runner, agent, abort.signal);
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
              baseSha: pr.base.sha, headSha: pr.head.sha, pr, description: `${pr.title}\n${pr.body ?? ''}` }, config, store, runner, agent, signal);
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
