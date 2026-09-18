import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCommands, type RunnerConfig, type TestCommand } from '../../domain/runner-config.js';
import type { Snapshot, TestResult } from '../../domain/types.js';
import type { Runner } from '../../ports/runner.js';
import { RetryableError, throwIfAborted } from '../../shared/control.js';
import { execute } from '../../shared/process.js';
import { ownerLabels, resourceOwner } from '../../shared/resource-owner.js';
import { writeSnapshot } from '../storage/git.js';
import { DependencyStoppedError, DockerEnvironment, type DockerExecute } from './environment.js';
import { classifyTestResult } from './test-results.js';
import { XML_MARKER } from './language-reports.js';

export function runnerCommand(config: Pick<TestCommand, 'command' | 'reporter'>): string[] {
  if (config.command.some(arg => /^(--test-reporter|--reporter|--outputFile)/.test(arg))) throw new Error('Reporter flags are controller-owned.');
  if (config.reporter === 'node') return [config.command[0]!, '--test-reporter=/repopilot/node-reporter.mjs', ...config.command.slice(1)];
  if (config.reporter === 'vitest') return [...config.command, '--reporter=json'];
  if (config.reporter === 'pytest') return [...config.command, '--junitxml=/tmp/repopilot.xml', '-o', 'junit_family=legacy'];
  if (config.reporter === 'go') return ['go', 'test', '-json', '-count=1', ...config.command.slice(2)];
  return [...config.command];
}
export function nodeReporterUrl(): URL {
  return new URL('../../../dist/adapters/testing/node-reporter.js', import.meta.url);
}
const failure = (output: string): TestResult => ({ status: 'error', exitCode: null, output, durationMs: 0, cases: [], structured: false });
export function runnerScript(step: TestCommand): string {
  const setup = 'mkdir /tmp/work && cp -R /source/. /tmp/work/ && cd "/tmp/work/$1" && shift';
  if (!['pytest', 'junit'].includes(step.reporter)) return setup + ' && exec "$@"';
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const paths = step.reporter === 'junit' && step.reportDirectory ? quote(step.reportDirectory) + '/*.xml'
    : (step.reporter === 'pytest' ? ['/tmp/repopilot.xml'] : step.reportFiles!).map(quote).join(' ');
  return setup + ' || exit 127; for report in ' + paths + '; do rm -f -- "$report" || exit 127; done; '
    + '"$@" >&2; result=$?; for report in ' + paths + '; do printf %s ' + quote(XML_MARKER)
    + '; cat -- "$report" || exit 127; done; exit "$result"';
}

export class DockerRunner implements Runner {
  private runProcess: DockerExecute;
  constructor(private config: RunnerConfig, private dataDir: string,
    private options: { execute?: DockerExecute; reporterSource?: URL } = {}) {
    this.runProcess = options.execute ?? execute;
  }
  async run(files: Snapshot, label: string, parent?: AbortSignal): Promise<TestResult> {
    throwIfAborted(parent);
    const start = Date.now(), prefix = 'repopilot-test-' + randomUUID();
    const root = resolve(this.dataDir, 'work', prefix), source = resolve(root, 'source'), support = resolve(root, 'support');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Test environment time budget exceeded.')), this.config.timeoutSeconds * 1000);
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    const environment = new DockerEnvironment(this.runProcess);
    const commands: NonNullable<TestResult['commands']> = [];
    const containers: string[] = [];
    let result = failure('Test environment did not complete.');
    let cleanupErrors: string[] = [];
    try {
      const steps = testCommands(this.config);
      for (const step of steps) {
        if (step.cwd && ![...files.keys()].some(path => path.startsWith(step.cwd + '/'))) throw new Error('Test working directory is missing: ' + step.cwd);
      }
      await mkdir(source, { recursive: true }); await mkdir(support, { recursive: true });
      await writeSnapshot(source, files);
      if (steps.some(step => step.reporter === 'node')) {
        await copyFile(fileURLToPath(this.options.reporterSource ?? nodeReporterUrl()), resolve(support, 'node-reporter.mjs'));
      }
      const owner = await resourceOwner(this.dataDir);
      const network = await environment.start(prefix, this.config.services ?? [], signal, owner);
      for (const step of steps) {
        signal.throwIfAborted();
        const name = prefix + '-command-' + step.name, commandStart = Date.now();
        containers.push(name);
        const execution = await this.runProcess('docker', ['run', '--rm', '--pull=never', '--name', name,
          ...ownerLabels(owner),
          '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--pids-limit', '128', '--memory', this.config.memory, '--cpus', String(this.config.cpus),
          '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
          '--mount', 'type=bind,source=' + source + ',target=/source,readonly',
          '--mount', 'type=bind,source=' + support + ',target=/repopilot,readonly',
          ...Object.entries({ ...(step.reporter === 'go' ? { GOCACHE: '/tmp/go-build', GOPATH: '/tmp/go', GOTOOLCHAIN: 'local' } : {}), ...this.config.env, ...step.env }).flatMap(([key, value]) => ['--env', key + '=' + value]),
          '--workdir', '/tmp', '--entrypoint', '/bin/sh', step.image ?? this.config.image,
          '-c', runnerScript(step),
          'repopilot', step.cwd, ...runnerCommand(step)],
          { timeoutMs: (step.timeoutSeconds ?? this.config.timeoutSeconds) * 1000, signal });
        if (execution.code === 125) throw new RetryableError('Docker could not start the test container.');
        const parsed = classifyTestResult(execution, step.reporter, Date.now() - commandStart, '/tmp/work', step.cwd, files);
        if (this.config.commands) parsed.cases = parsed.cases.map(c => ({ ...c, command: step.name, id: JSON.stringify([step.name, c.id]) }));
        commands.push({ ...parsed, name: step.name, cwd: step.cwd });
        await environment.assertRunning(signal);
        if (parsed.status === 'error') break;
      }
      signal.throwIfAborted();
      const incomplete = commands.length !== steps.length;
      const status = incomplete || commands.some(c => c.status === 'error') ? 'error'
        : commands.some(c => c.status === 'not_run') ? 'not_run'
        : commands.some(c => c.status === 'failed') ? 'failed' : 'passed';
      result = { status, exitCode: status === 'passed' ? 0 : commands.find(c => c.exitCode !== 0)?.exitCode ?? 1,
        failure: commands.find(c => c.status === 'error')?.failure,
        output: commands.map(c => '[' + c.name + ']\n' + c.output).join('\n').slice(-100000),
        durationMs: Date.now() - start, cases: commands.flatMap(c => c.cases),
        structured: !incomplete && commands.every(c => c.structured),
        reason: incomplete ? 'Some test commands did not execute.' : commands.map(c => c.reason).filter(Boolean).join('\n') || undefined };
    } catch (error) {
      throwIfAborted(parent);
      result = failure(label + ': ' + String(error));
      const retryable = error instanceof RetryableError || error instanceof DependencyStoppedError || deadline.signal.aborted
        || (error instanceof Error && error.name === 'TimeoutError');
      result.failure = { kind: 'environment', retryable };
    } finally {
      clearTimeout(timer);
      for (const name of containers.reverse()) {
        try {
          const removed = await this.runProcess('docker', ['rm', '-f', '-v', name], { timeoutMs: 10000 });
          if (removed.timedOut || (removed.code !== 0 && !/No such container/i.test(removed.stderr))) cleanupErrors.push('Test container cleanup failed: ' + name);
        } catch { cleanupErrors.push('Test container cleanup failed: ' + name); }
      }
      cleanupErrors.push(...await environment.cleanup());
    }
    throwIfAborted(parent);
    if (cleanupErrors.length) result = { ...result, status: 'error', failure: { kind: 'environment', retryable: false }, reason: cleanupErrors.join('\n') };
    return { ...result, commands, durationMs: Date.now() - start };
  }
}
