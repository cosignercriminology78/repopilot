import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { DockerRunner } from '../src/adapters/testing/docker-runner.js';
import { testFile } from '../src/adapters/testing/test-results.js';
import { describeTestEnvironment, runnerSchema } from '../src/domain/runner-config.js';
import { testId } from '../src/domain/test-evidence.js';
import type { Snapshot } from '../src/domain/types.js';
import type { ProcessOptions, ProcessResult } from '../src/shared/process.js';

const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const report = (status: 'passed' | 'failed' = 'passed', empty = false): ProcessResult => ({ ...ok(JSON.stringify({
  format: 'repopilot-node-v1', infrastructureErrors: [], cases: empty ? [] : [
    { file: 'test.js', name: 'works', status, durationMs: 1, failure: status === 'failed' ? 'expected 1, got 2' : undefined }
  ] })), code: status === 'failed' ? 1 : 0 });
const service = { name: 'default', image: 'redis:7-alpine', tmpfs: ['/data'], readiness: { command: ['redis-cli', 'ping'] } };
const command = ['node', '--test'];
const files: Snapshot = new Map([['packages/api/test.js', 'test'], ['test.js', 'test']]);
type Call = { args: string[]; options: ProcessOptions };
async function fixture(t: TestContext, raw: unknown,
  respond: (call: Call) => ProcessResult | Promise<ProcessResult> = () => report()) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reporter = resolve(root, 'reporter.mjs'); await writeFile(reporter, '// trusted reporter');
  const calls: Call[] = [];
  const runner = new DockerRunner(runnerSchema.parse(raw), root, { reporterSource: pathToFileURL(reporter),
    execute: async (binary, args, options = {}) => {
      assert.equal(binary, 'docker'); const call = { args, options }; calls.push(call);
      return respond(call);
    } });
  return { runner, calls };
}
const isTest = (args: string[]) => args[0] === 'run' && !args.includes('--detach');
const defaultResponse = ({ args }: Call) => isTest(args) ? report() : ok(args[0] === 'inspect' ? 'true' : '');

test('legacy runner defaults and case identities remain compatible', async t => {
  assert.deepEqual(runnerSchema.parse({ command }), { image: 'node:22-bookworm-slim', command,
    reporter: 'node', timeoutSeconds: 300, memory: '1g', cpus: 2 });
  const { runner, calls } = await fixture(t, { command }, defaultResponse);
  const result = await runner.run(files, 'head');
  assert.equal(result.status, 'passed'); assert.equal(result.cases[0]?.id, testId('test.js', 'works'));
  const args = calls.find(c => isTest(c.args))!.args;
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--pull=never')); assert.ok(!calls.some(c => c.args[0] === 'network'));
});

test('multiple commands preserve failures and namespace identical cases', async t => {
  let count = 0;
  const { runner } = await fixture(t, { commands: [{ name: 'one', command }, { name: 'two', command }] },
    c => isTest(c.args) ? report(count++ === 0 ? 'failed' : 'passed') : ok());
  const result = await runner.run(files, 'head');
  assert.equal(result.status, 'failed'); assert.equal(result.commands?.length, 2);
  assert.notEqual(result.cases[0]?.id, result.cases[1]?.id);
  assert.deepEqual(result.cases.map(c => c.command), ['one', 'two']);
});

test('empty results in any command block a passing aggregate', async t => {
  let count = 0;
  const { runner } = await fixture(t, { commands: [{ name: 'one', command }, { name: 'two', command }] },
    c => isTest(c.args) ? report('passed', count++ === 0) : ok());
  assert.equal((await runner.run(files, 'head')).status, 'not_run');
});

test('working directories normalize relative results and reject missing directories', async t => {
  const { runner, calls } = await fixture(t, { command, cwd: 'packages/api' }, defaultResponse);
  assert.equal((await runner.run(files, 'head')).cases[0]?.file, 'packages/api/test.js');
  assert.ok(calls.find(c => isTest(c.args))!.args.includes('packages/api'));
  assert.equal(testFile('/tmp/work/packages/api/test.js', '/tmp/work', 'packages/api'), 'packages/api/test.js');
  assert.throws(() => testFile('../../../outside', '/tmp/work', 'packages/api'));
  assert.throws(() => testFile(''));
  const missing = await fixture(t, { command, cwd: 'missing' }, defaultResponse);
  assert.equal((await missing.runner.run(files, 'head')).status, 'error'); assert.equal(missing.calls.length, 0);
});

test('dependency runs use fresh internal networks, separate names and reverse cleanup', async t => {
  const { runner, calls } = await fixture(t, { command, services: [service], env: { REDIS_HOST: 'default' } }, defaultResponse);
  assert.equal((await runner.run(files, 'base')).status, 'passed');
  assert.equal((await runner.run(files, 'head')).status, 'passed');
  const networks = calls.filter(c => c.args[0] === 'network' && c.args[1] === 'create');
  assert.equal(networks.length, 2); assert.notEqual(networks[0]!.args.at(-1), networks[1]!.args.at(-1));
  assert.ok(networks.every(c => c.args.includes('--internal')));
  const launches = calls.filter(c => c.args[0] === 'run');
  assert.equal(new Set(launches.map(c => c.args[c.args.indexOf('--name') + 1])).size, 4);
  assert.ok(launches.every(c => c.args.includes('--read-only') && !c.args.includes('-p')));
  assert.ok(launches.every(c => c.args.includes('io.repopilot.managed=true') && c.args.some(arg => /^io\.repopilot\.owner=[a-f0-9]{64}$/.test(arg))));
  assert.ok(networks.every(c => c.args.includes('io.repopilot.managed=true')));
  assert.ok(launches.filter(c => c.args.includes('--detach')).every(c => c.args.some(arg => arg.includes('uid=65534,gid=65534'))));
  const cleanup = calls.filter(c => c.args[0] === 'rm' || c.args[1] === 'rm');
  assert.match(cleanup[0]!.args.at(-1)!, /-command-default$/);
  assert.match(cleanup[1]!.args.at(-1)!, /-service-default$/);
  assert.equal(cleanup[2]!.args[0], 'network');
  assert.ok(cleanup.every(c => !c.options.signal));
  assert.ok(cleanup.filter(c => c.args[0] === 'rm').every(c => c.args.includes('-v')));
});

test('partial service startup failure cleans resources before retry', async t => {
  const { runner, calls } = await fixture(t, { command, services: [service] }, c => c.args.includes('--detach')
    ? { ...ok(), code: 125 } : defaultResponse(c));
  const result = await runner.run(files, 'head');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.failure, { kind: 'environment', retryable: true });
  assert.ok(calls.some(c => c.args[0] === 'rm')); assert.equal(calls.at(-1)?.args[1], 'rm');
});

test('dead services and failed cleanup invalidate passing tests', async t => {
  for (const failure of ['inspect', 'rm']) {
    const { runner } = await fixture(t, { command, services: [service] }, c => c.args[0] === failure
      ? { ...ok('false'), code: 1 } : defaultResponse(c));
    assert.equal((await runner.run(files, 'head')).status, 'error');
  }
});

test('command timeout stops subsequent commands and cleans the environment', async t => {
  const { runner, calls } = await fixture(t, { commands: [{ name: 'one', command }, { name: 'two', command }], services: [service] },
    c => isTest(c.args) ? { ...ok(), code: null, timedOut: true } : defaultResponse(c));
  assert.equal((await runner.run(files, 'head')).status, 'error');
  assert.equal(calls.filter(c => isTest(c.args)).length, 1); assert.equal(calls.at(-1)?.args[1], 'rm');
});

test('cancellation during readiness still cleans containers and network', async t => {
  const parent = new AbortController();
  const { runner, calls } = await fixture(t, { command, services: [service] }, c => {
    if (c.args[0] === 'exec') { parent.abort(new Error('cancelled')); c.options.signal!.throwIfAborted(); }
    return defaultResponse(c);
  });
  await assert.rejects(runner.run(files, 'head', parent.signal), /cancelled/);
  assert.equal(calls.at(-1)?.args[1], 'rm');
  assert.ok(!calls.some(c => isTest(c.args)));
});

test('configuration rejects ambiguous commands and unsafe environment settings', () => {
  for (const input of [{}, { command, commands: [{ name: 'one', command }] }, { command, cwd: '../escape' },
    { command, env: { GITHUB_TOKEN: 'secret' } }, { command, services: [{ ...service, user: '0:0' }] },
    { commands: [{ name: 'one', command }, { name: 'one', command }] },
    { command, services: [{ ...service, ports: [6379] }] }, { command: ['node', '--test', '--test-reporter=tap'] }]) {
    assert.equal(runnerSchema.safeParse(input).success, false);
  }
  const description = describeTestEnvironment(runnerSchema.parse({ command, env: { DATABASE_URL: 'secret-value' }, services: [service] }));
  assert.deepEqual(description.commands[0]?.environmentVariables, ['DATABASE_URL']);
  assert.ok(!JSON.stringify(description).includes('secret-value'));
});

test('readiness timeout and total environment budget stop before test execution', async t => {
  for (const readinessTimeout of [1, 30]) {
    const { runner, calls } = await fixture(t, { command, timeoutSeconds: readinessTimeout === 1 ? 5 : 1,
      services: [{ ...service, readiness: { command: ['redis-cli', 'ping'], timeoutSeconds: readinessTimeout } }] }, c => {
      if (c.args[0] !== 'exec') return defaultResponse(c);
      return new Promise<ProcessResult>((_resolve, reject) => {
        c.options.signal!.addEventListener('abort', () => reject(c.options.signal!.reason), { once: true });
      });
    });
    assert.equal((await runner.run(files, 'head')).status, 'error');
    assert.ok(!calls.some(c => isTest(c.args))); assert.equal(calls.at(-1)?.args[1], 'rm');
  }
});
