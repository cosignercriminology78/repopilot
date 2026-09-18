import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const command = z.array(z.string().min(1)).min(1);
export const configSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  dataDir: z.string().default('.repopilot-data'),
  pollSeconds: z.number().int().min(15).default(60),
  runner: z.object({
    image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/).default('node:22-bookworm-slim'),
    command,
    timeoutSeconds: z.number().int().min(1).max(1800).default(300),
    memory: z.string().regex(/^\d+[mg]$/).default('1g'),
    cpus: z.number().positive().max(16).default(2)
  }).optional(),
  agent: z.object({
    enabled: z.boolean().default(false),
    repair: z.boolean().default(false),
    image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/).default('repopilot-agent:local'),
    model: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().min(10).max(1800).default(300),
    maxAttempts: z.number().int().min(1).max(3).default(2)
  }).default({ enabled: false, repair: false, image: 'repopilot-agent:local', timeoutSeconds: 300, maxAttempts: 2 }),
  publish: z.boolean().default(false)
}).strict();
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(path: string): Promise<Config> {
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.dataDir = resolve(config.dataDir);
  if (config.publish && (!config.agent.enabled || !config.agent.repair || !config.runner)) {
    throw new Error('Publishing requires agent.enabled, agent.repair and a test runner.');
  }
  return config;
}
