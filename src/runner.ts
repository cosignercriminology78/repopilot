import { randomUUID } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { execute } from './process.js';
import { writeSnapshot } from './git.js';
import { classifyTestResult } from './test-results.js';
import { throwIfAborted, RetryableError } from './control.js';
import type { Snapshot, TestResult } from './types.js';

export interface Runner { run(files: Snapshot, label: string, signal?: AbortSignal): Promise<TestResult>; }
export const notRun = (): TestResult => ({ status: 'not_run', exitCode: null, output: 'No test runner configured.',
  durationMs: 0, cases: [], structured: false });
export function runnerCommand(config: NonNullable<Config['runner']>): string[] {
  if (config.command.some(arg => /^(--test-reporter|--reporter|--outputFile)/.test(arg))) throw new Error('Reporter flags are controller-owned.');
  if (config.reporter === 'node') return [config.command[0]!, '--test-reporter=/repopilot/node-reporter.mjs', ...config.command.slice(1)];
  if (config.reporter === 'vitest') return [...config.command, '--reporter=json'];
  return [...config.command];
}
export class DockerRunner implements Runner {
  constructor(private config: NonNullable<Config['runner']>, private dataDir: string) {}
  async run(files: Snapshot, label: string, signal?: AbortSignal): Promise<TestResult> {
    throwIfAborted(signal);
    const start = Date.now(), name = `repopilot-test-${randomUUID()}`;
    const root = resolve(this.dataDir, 'work', name), source = resolve(root, 'source'), support = resolve(root, 'support');
    await mkdir(support, { recursive: true });
    await writeSnapshot(source, files);
    // Build first: the trusted reporter is JS and does not depend on repository packages.
    if (this.config.reporter === 'node') await copyFile(fileURLToPath(new URL('../dist/node-reporter.js', import.meta.url)), resolve(support, 'node-reporter.mjs'));
    try {
      const result = await execute('docker', ['run', '--rm', '--name', name,
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--memory', this.config.memory, '--cpus', String(this.config.cpus),
        '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--mount', `type=bind,source=${source},target=/source,readonly`,
        '--mount', `type=bind,source=${support},target=/repopilot,readonly`,
        '--workdir', '/tmp', '--entrypoint', '/bin/sh', this.config.image,
        '-c', 'mkdir /tmp/work && cp -R /source/. /tmp/work/ && cd /tmp/work && exec "$@"', 'repopilot', ...runnerCommand(this.config)],
        { timeoutMs: this.config.timeoutSeconds * 1000, signal });
      if (result.code === 125) throw new RetryableError('Docker could not start the test container.');
      return classifyTestResult(result, this.config.reporter, Date.now() - start);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof RetryableError) throw error;
      return { status: 'error', exitCode: null, output: `${label}: ${String(error)}`, durationMs: Date.now() - start, cases: [], structured: false };
    } finally {
      await execute('docker', ['rm', '-f', name], { timeoutMs: 10000 }).catch(() => undefined);
    }
  }
}
