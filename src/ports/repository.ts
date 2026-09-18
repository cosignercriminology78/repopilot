import type { Snapshot } from '../domain/types.js';
export interface Repository {
  resolveCommit(repo: string, ref: string): Promise<string>;
  snapshot(repo: string, sha: string, signal?: AbortSignal): Promise<Snapshot>;
  prepare(repo: string): Promise<void>;
  fetch(repo: string, repository: string, base: string, head: string, signal?: AbortSignal): Promise<void>;
}
