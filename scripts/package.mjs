import { cp, mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported release target');
const name = `repopilot-${version}-${platform}-${process.arch}`;
const root = resolve('.cache/release', name);
await mkdir(root, { recursive: true });
for (const file of ['dist', 'node_modules', 'package.json', 'package-lock.json', 'repopilot.example.json', 'LICENSE', 'SECURITY.md', 'README.md', 'README.zh-CN.md', 'docs', 'examples', 'Dockerfile.agent', '.dockerignore', 'src', 'tsconfig.json']) {
  await cp(file, join(root, file), { recursive: true });
}
await cp('docs/QUICKSTART.md', join(root, 'QUICKSTART.md'));
await mkdir(join(root, 'runtime'), { recursive: true });
const runtime = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
await cp(process.execPath, runtime); await chmod(runtime, 0o755);
let license;
for (const path of [join(dirname(process.execPath), 'LICENSE'), join(dirname(process.execPath), '../LICENSE')]) {
  if (await stat(path).catch(() => false)) { license = await readFile(path); break; }
}
if (!license) throw new Error('Bundled Node runtime LICENSE is required');
await writeFile(join(root, 'runtime/LICENSE'), license);
if (process.platform === 'win32') {
  await writeFile(join(root, 'repopilot.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
} else {
  await writeFile(join(root, 'repopilot'), '#!/bin/sh\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/runtime/node" "$ROOT/dist/cli.js" "$@"\n');
  await chmod(join(root, 'repopilot'), 0o755);
}
const actual = execFileSync(runtime, [join(root, 'dist/cli.js'), '--version'], { encoding: 'utf8' }).trim();
if (actual !== version) throw new Error('Packaged version mismatch');
const launched = process.platform === 'win32'
  ? execFileSync('cmd.exe', ['/d', '/c', join(root, 'repopilot.cmd'), '--version'], { encoding: 'utf8', cwd: tmpdir() })
  : execFileSync(join(root, 'repopilot'), ['--version'], { encoding: 'utf8', cwd: tmpdir() });
if (launched.trim() !== version) throw new Error('Portable launcher failed');
await mkdir('.cache/assets', { recursive: true });
if (process.platform === 'win32') {
  const archive = resolve('.cache/assets', name + '.zip');
  execFileSync('tar', ['-a', '-cf', archive, '-C', dirname(root), name]);
} else {
  execFileSync('tar', ['-czf', resolve('.cache/assets', name + '.tar.gz'), '-C', dirname(root), name]);
}
console.log('Packaged ' + name);
