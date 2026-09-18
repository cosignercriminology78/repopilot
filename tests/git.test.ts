import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { checked, execute } from '../src/process.js';
import { resolveCommit, snapshot } from '../src/git.js';

test('real Git snapshots and CLI compare pinned commits without editing checkout', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/tests/git-'));
  await checked('git', ['init', '-b', 'main'], root);
  await checked('git', ['config', 'user.name', 'RepoPilot Test'], root);
  await checked('git', ['config', 'user.email', 'test@example.invalid'], root);
  await mkdir(join(root, '.repopilot'));
  await writeFile(join(root, '.repopilot/policy.json'), JSON.stringify({ rules: [{ id: 'no-bad', forbiddenText: 'BAD', extensions: ['.ts'], message: 'No bad code' }] }));
  await writeFile(join(root, 'a.ts'), 'GOOD\n');
  await checked('git', ['add', '.'], root); await checked('git', ['commit', '-m', 'base'], root);
  const base = await resolveCommit(root, 'HEAD');
  await writeFile(join(root, 'a.ts'), 'BAD\n');
  await checked('git', ['add', '.'], root); await checked('git', ['commit', '-m', 'regression'], root);
  const head = await resolveCommit(root, 'HEAD');
  assert.equal((await snapshot(root, base)).get('a.ts'), 'GOOD\n');
  assert.equal((await snapshot(root, head)).get('a.ts'), 'BAD\n');
  const configuration = join(root, 'controller.local.json');
  await writeFile(configuration, JSON.stringify({ repository: 'example/repo', dataDir: join(root, 'reports') }));
  const output = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'check', '--config', configuration,
    '--repo', root, '--base', base, '--head', head]);
  assert.equal(output.code, 2, output.stderr);
  assert.equal(JSON.parse(output.stdout).findings, 1);
  assert.equal(await resolveCommit(root, 'HEAD'), head);
});
