import type { Answer } from '../domain/agent-answer.js';
import type { AgentRole } from '../domain/collaboration.js';
import type { Snapshot } from '../domain/types.js';

export interface Agent {
  design?(base: Snapshot, context: string, signal?: AbortSignal): Promise<Answer>;
  review(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, paths?: string[]): Promise<Answer>;
  plan(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, intent?: 'feature' | 'bugfix'): Promise<Answer>;
  repair(base: Snapshot, head: Snapshot, evidence: string, signal?: AbortSignal, intent?: 'feature' | 'bugfix'): Promise<Answer>;
  resetBudget?(): void;
  usage?(): { calls: number; tokens: number; complete?: boolean };
  forRole?(role: AgentRole): Agent;
  forkExecution?(): Agent;
}

export function roleAgent(agent: Agent, role: AgentRole): Agent {
  return agent.forRole?.(role) ?? agent;
}
