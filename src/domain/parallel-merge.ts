import { createHash } from 'node:crypto';
import { applyChanges } from './repair.js';
import { changedPaths } from './snapshot.js';
import type { RepairChange, Snapshot } from './types.js';

/** Bind a parallel wave to its immutable input, including executable modes. */
export function snapshotDigest(snapshot: Snapshot): string {
  const files = [...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => [path, content, snapshot.modes?.get(path) ?? '100644']);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 24);
}

/** File-level merge deliberately rejects every overlapping edit, even identical replacements. */
export function mergeParallelChanges(base: Snapshot, branches: { step: string; changes: RepairChange[] }[]): Snapshot {
  const owners = new Map<string, string>();
  const changes: RepairChange[] = [];
  for (const branch of branches) {
    const candidate = applyChanges(base, branch.changes);
    for (const path of changedPaths(base, candidate)) {
      const owner = owners.get(path);
      if (owner) throw new Error(`Parallel merge conflict on ${path}: ${owner} and ${branch.step}.`);
      owners.set(path, branch.step);
      changes.push({ path, content: candidate.get(path)! });
    }
  }
  if (!changes.length) throw new Error('Parallel merge has no verified changes.');
  return applyChanges(base, changes);
}
