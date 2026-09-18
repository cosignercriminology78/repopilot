import { posix } from 'node:path';
import { changedPaths } from './git.js';
import { instructions } from './policy.js';
import type { Snapshot } from './types.js';

export interface ContextBatch {
  diff: { path: string; before?: string; after?: string; beforeMode?: string; afterMode?: string; rules: { path: string; content: string }[] }[];
  files: { path: string; content: string }[];
  omitted: string[];
}
export function contextBatches(base: Snapshot, head: Snapshot, paths = changedPaths(base, head), maxBytes = 300000): ContextBatch[] {
  const batches: ContextBatch[] = [];
  let batch: ContextBatch = { diff: [], files: [], omitted: [] };
  const size = (item: unknown) => Buffer.byteLength(JSON.stringify(item));
  for (const path of [...new Set(paths)].sort()) {
    const entry = { path, before: base.get(path), after: head.get(path), beforeMode: base.modes?.get(path), afterMode: head.modes?.get(path), rules: instructions(base, path) };
    if (size(entry) > maxBytes) throw new Error('One changed file exceeds the agent context budget: ' + path);
    if (batch.diff.length && size({ ...batch, diff: [...batch.diff, entry] }) > maxBytes) {
      batches.push(batch); batch = { diff: [], files: [], omitted: [] };
    }
    batch.diff.push(entry);
  }
  if (batch.diff.length) batches.push(batch);
  for (const current of batches) {
    const present = new Set(current.diff.map(d => d.path));
    const related = new Set<string>();
    for (const entry of current.diff) {
      const text = entry.after ?? '';
      for (const match of text.matchAll(/(?:from\s*|require\s*\(|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
        const stem = posix.normalize(posix.join(posix.dirname(entry.path), match[1]!));
        for (const candidate of [stem, stem + '.ts', stem + '.js', stem.replace(/\.js$/, '.ts'), stem + '/index.ts', stem + '/index.js']) {
          if (head.has(candidate)) related.add(candidate);
        }
      }
      for (const file of head.keys()) if (/test|spec/i.test(file) && file.includes(posix.basename(entry.path).replace(/\.[^.]+$/, ''))) related.add(file);
    }
    for (const file of ['package.json', 'tsconfig.json', 'README.md']) if (head.has(file)) related.add(file);
    for (const path of [...related].sort()) {
      if (present.has(path)) continue;
      const item = { path, content: head.get(path)! };
      if (size({ ...current, files: [...current.files, item] }) <= maxBytes) current.files.push(item);
      else current.omitted.push(path);
    }
  }
  return batches;
}
