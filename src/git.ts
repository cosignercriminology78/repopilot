import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checked } from './process.js';
import type { Snapshot } from './types.js';

export function safePath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') && !path.includes(':') && !/[\x00-\x1f]/.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));
}
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw new Error('Invalid git ref.');
  return (await checked('git', ['rev-parse', '--verify', `${ref}^{commit}`], repo)).trim();
}
export async function snapshot(repo: string, sha: string): Promise<Snapshot> {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Snapshot requires a commit SHA.');
  const entries = (await checked('git', ['ls-tree', '-rz', '--full-tree', sha], repo)).split('\0').filter(Boolean);
  if (entries.length > 10000) throw new Error('Repository exceeds MVP limit of 10,000 files.');
  const files: Snapshot = new Map();
  let total = 0;
  for (const entry of entries) {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1]!)) throw new Error('Symlinks and submodules are not supported in the MVP.');
    const path = match[3]!;
    if (!safePath(path)) throw new Error(`Unsafe repository path: ${path}`);
    const content = await checked('git', ['cat-file', 'blob', match[2]!], repo);
    if (content.includes('\0') || content.includes('\uFFFD')) throw new Error(`Binary/non-UTF8 file unsupported in MVP: ${path}`);
    total += Buffer.byteLength(content);
    if (total > 16 * 1024 * 1024) throw new Error('Repository exceeds MVP text limit of 16 MiB.');
    files.set(path, content);
  }
  return files;
}
export async function writeSnapshot(root: string, files: Snapshot): Promise<void> {
  for (const [path, content] of files) {
    if (!safePath(path)) throw new Error('Unsafe snapshot path.');
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
export function changedPaths(base: Snapshot, head: Snapshot): string[] {
  return [...new Set([...base.keys(), ...head.keys()])].filter(path => base.get(path) !== head.get(path)).sort();
}
