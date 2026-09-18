import type { Answer } from '../domain/agent-answer.js';
import type { Snapshot } from '../domain/types.js';

export interface Agent {
  review(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, paths?: string[]): Promise<Answer>;
  plan(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal): Promise<Answer>;
  repair(base: Snapshot, head: Snapshot, evidence: string, signal?: AbortSignal): Promise<Answer>;
  resetBudget?(): void;
  usage?(): { calls: number; tokens: number };
}
