import { createHash } from 'node:crypto';
import { z } from 'zod';

export const agentRoleSchema = z.enum(['planner', 'tester', 'developer', 'reviewer']);
export type AgentRole = z.infer<typeof agentRoleSchema>;

const roleConfig = z.object({ model: z.string().min(1).optional() }).strict();
export const collaborationSchema = z.object({
  maxParallel: z.number().int().min(1).max(4).default(1),
  resourceBudget: z.object({
    cpus: z.number().positive().max(128),
    memoryMiB: z.number().int().positive().max(1048576)
  }).strict().optional(),
  roles: z.object({
    planner: roleConfig.default({}), tester: roleConfig.default({}),
    developer: roleConfig.default({}), reviewer: roleConfig.default({})
  }).strict().default({ planner: {}, tester: {}, developer: {}, reviewer: {} })
}).strict();
export type CollaborationConfig = z.infer<typeof collaborationSchema>;

export interface AgentHandoff {
  id: string;
  role: AgentRole;
  action: 'design' | 'test_plan' | 'repair' | 'review';
  status: 'running' | 'completed' | 'rejected' | 'failed';
  inputDigest: string;
  outputDigest?: string;
  summary?: string;
  at: string;
}

export function handoffDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
