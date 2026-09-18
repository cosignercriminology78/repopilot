import { z } from 'zod';
import { goalStepSchema } from './iteration.js';

export const answerSchema = z.object({
  steps: z.array(goalStepSchema).max(20).optional(),
  findings: z.array(z.object({
    ruleId: z.string().min(1), path: z.string(), line: z.number().int().positive(),
    message: z.string().min(1), source: z.string(), severity: z.enum(['error', 'warning']),
    ruleQuote: z.string().min(3), evidence: z.string().min(1)
  }).strict()).max(100),
  changes: z.array(z.object({ path: z.string(), content: z.string().max(200000) }).strict()).max(20),
  scenarios: z.array(z.object({ name: z.string().min(1), requirement: z.string().min(1), testFile: z.string(),
    kind: z.enum(['regression', 'new_behavior']).optional(), requirementQuote: z.string().min(8).optional()
  }).strict()).max(50),
  summary: z.string()
}).strict();
export type Answer = z.infer<typeof answerSchema>;
