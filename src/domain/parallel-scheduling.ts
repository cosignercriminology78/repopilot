import type { CollaborationConfig } from './collaboration.js';
import { applyChanges } from './repair.js';
import { changedPaths } from './snapshot.js';
import type { RunnerConfig } from './runner-config.js';
import type { RepairChange, Snapshot } from './types.js';

function memoryMiB(value: string): number {
  const amount = Number(value.slice(0, -1));
  return value.endsWith('g') ? amount * 1024 : amount;
}

/** A conservative per-node reservation: Codex plus the runner and all configured services. */
export function parallelCapacity(collaboration: CollaborationConfig | undefined, runner: RunnerConfig | undefined): number {
  const configured = collaboration?.maxParallel ?? 1;
  const budget = collaboration?.resourceBudget;
  if (!budget) return configured;
  const cpu = 2 + (runner?.cpus ?? 2) + (runner?.services ?? []).reduce((sum, service) => sum + service.cpus, 0);
  const memory = 2048 + memoryMiB(runner?.memory ?? '1g')
    + (runner?.services ?? []).reduce((sum, service) => sum + memoryMiB(service.memory), 0);
  const capacity = Math.min(configured, Math.floor(budget.cpus / cpu), Math.floor(budget.memoryMiB / memory));
  if (capacity < 1) throw new Error(`Parallel resource budget cannot accommodate one node (${cpu} CPUs, ${memory} MiB).`);
  return capacity;
}

export interface ParallelBranch { step: string; changes: RepairChange[] }
export interface ParallelConflict { path: string; owner: string; deferred: string }

/** Keep the first owner of each path and replay later conflicting nodes on the new snapshot. */
export function partitionParallelBranches(base: Snapshot, branches: ParallelBranch[]) {
  const owners = new Map<string, string>();
  const accepted: ParallelBranch[] = [], deferred: string[] = [], conflicts: ParallelConflict[] = [];
  for (const branch of branches) {
    const candidate = applyChanges(base, branch.changes);
    const paths = changedPaths(base, candidate);
    const overlap = paths.filter(path => owners.has(path));
    if (overlap.length) {
      deferred.push(branch.step);
      conflicts.push(...overlap.map(path => ({ path, owner: owners.get(path)!, deferred: branch.step })));
      continue;
    }
    accepted.push(branch);
    for (const path of paths) owners.set(path, branch.step);
  }
  return { accepted, deferred, conflicts, pathOwners: Object.fromEntries(owners) };
}
