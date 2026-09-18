import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { main } from '../src/cli/bootstrap.js';
import { doctor } from '../src/cli/commands/setup.js';
import { VERSION } from '../src/shared/version.js';

test('init writes versioned safe defaults without overwriting existing configuration', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/setup-')), path = resolve(root, 'config.json');
  const output = { write: (_value: string) => {}, error: (_value: string) => {} };
  assert.equal(await main(['init', '--repo', 'owner/repo', '--config', path], output), 0);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.agent.image, 'ghcr.io/indada/repopilot-agent:' + VERSION);
  assert.equal(config.agent.enabled, false); assert.equal(config.agent.repair, false); assert.equal(config.publish, false);
  await assert.rejects(main(['init', '--repo', 'owner/other', '--config', path], output), /EEXIST/);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).repository, 'owner/repo');
  const lines: string[] = [];
  assert.equal(await main(['--version'], { ...output, write: text => lines.push(text) }), 0);
  assert.deepEqual(lines, [JSON.parse(await readFile('package.json', 'utf8')).version]);
  const calls: string[][] = [];
  const exit = await doctor({ config: path }, { ...output, write: text => lines.push(text) }, async (_binary, args) => {
    calls.push(args); return { code: 0, stdout: args[0] === 'info' ? 'windows' : '', stderr: 'sensitive daemon output', timedOut: false };
  });
  assert.equal(exit, 1); assert.ok(lines.some(line => line.includes('FAIL Docker daemon')));
  assert.ok(!lines.join('\n').includes('sensitive daemon output'));
  assert.ok(calls.every(args => ['--version', 'info', 'image'].includes(args[0]!)));
});
