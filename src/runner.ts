import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import { execute } from './process.js';
import { writeSnapshot } from './git.js';
import type { Snapshot, TestResult } from './types.js';

export interface Runner { run(files: Snapshot, label: string): Promise<TestResult>; }
export const notRun = (): TestResult => ({ status: 'not_run', exitCode: null, output: 'No test runner configured.', durationMs: 0 });
export class DockerRunner implements Runner {
  constructor(private config: NonNullable<Config['runner']>, private dataDir: string) {}
  async run(files: Snapshot, label: string): Promise<TestResult> {
    const start = Date.now(), name = `repopilot-test-${randomUUID()}`;
    const root = resolve(this.dataDir, 'work', name);
    await mkdir(root, { recursive: true });
    await writeSnapshot(root, files);
    try {
      const result = await execute('docker', ['run', '--rm', '--name', name,
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--memory', this.config.memory, '--cpus', String(this.config.cpus),
        '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--mount', `type=bind,source=${root},target=/source,readonly`,
        '--workdir', '/tmp', '--entrypoint', '/bin/sh', this.config.image,
        '-c', 'mkdir /tmp/work && cp -R /source/. /tmp/work/ && cd /tmp/work && exec "$@"', 'repopilot', ...this.config.command],
        { timeoutMs: this.config.timeoutSeconds * 1000 });
      const status = result.timedOut || result.code === null || [125, 126, 127, 137].includes(result.code)
        ? 'error' : result.code === 0 ? 'passed' : 'failed';
      return { status, exitCode: result.code, output: `${label}\n${result.stdout}${result.stderr}`.slice(-100_000), durationMs: Date.now() - start };
    } catch (error) {
      return { status: 'error', exitCode: null, output: String(error), durationMs: Date.now() - start };
    } finally {
      // Killing the docker client alone does not stop a container.
      await execute('docker', ['rm', '-f', name], { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }
}
