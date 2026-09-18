import { z } from 'zod';
import { safePath } from './snapshot.js';

const command = z.array(z.string().min(1)).min(1);
const image = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/);
const reporter = z.enum(['node', 'vitest', 'command']);
const memory = z.string().regex(/^\d+[mg]$/);
const cwd = z.string().refine(value => value === '' || safePath(value), 'Working directory must be a repository-relative path.');
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(key => !/^(GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key), 'Controller credentials are forbidden in test environments.'), z.string());
const name = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const stepSchema = z.object({
  name, command, cwd: cwd.default(''), reporter: reporter.default('node'),
  image: image.optional(), env: env.optional(),
  timeoutSeconds: z.number().int().min(1).max(1800).optional()
}).strict();
const serviceSchema = z.object({
  name, image, command: command.optional(), env: env.default({}),
  user: z.string().regex(/^[1-9]\d*:[1-9]\d*$/).default('65534:65534'),
  memory: memory.default('512m'), cpus: z.number().positive().max(16).default(1),
  tmpfs: z.array(z.string().refine(p => p.startsWith('/') && p !== '/' && safePath(p.slice(1))
    && !p.includes(',') && !p.includes(':'), 'Invalid service tmpfs path.')).max(8).default([]),
  readiness: z.object({ command, timeoutSeconds: z.number().int().min(1).max(300).default(30) }).strict()
}).strict();
export const runnerSchema = z.object({
  image: image.default('node:22-bookworm-slim'),
  command: command.optional(), commands: z.array(stepSchema).min(1).max(8).optional(),
  cwd: cwd.optional(), env: env.optional(), services: z.array(serviceSchema).max(4).optional(),
  reporter: reporter.default('node'),
  timeoutSeconds: z.number().int().min(1).max(1800).default(300),
  memory: memory.default('1g'), cpus: z.number().positive().max(16).default(2)
}).strict().superRefine((config, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!!config.command === !!config.commands) issue('Specify exactly one of runner.command or runner.commands.');
  if (config.commands && config.cwd) issue('Use per-command cwd with runner.commands.');
  for (const entries of [config.commands ?? [], config.services ?? []]) {
    if (new Set(entries.map(e => e.name)).size !== entries.length) issue('Command/service names must be unique.');
  }
  for (const step of config.commands ?? (config.command ? [{ command: config.command, reporter: config.reporter }] : [])) {
    if (step.command.some(arg => /^(--test-reporter|--reporter|--outputFile)/.test(arg))) issue('Reporter flags are controller-owned.');
    if (step.reporter === 'node' && (step.command[0] !== 'node' || !step.command.includes('--test'))) issue('The node reporter requires a node --test command.');
  }
});
export type RunnerConfig = z.infer<typeof runnerSchema>;
export type TestCommand = z.infer<typeof stepSchema>;
export type TestService = z.infer<typeof serviceSchema>;
export function testCommands(config: RunnerConfig): TestCommand[] {
  return config.commands ?? [{ name: 'default', command: config.command!, cwd: config.cwd ?? '', reporter: config.reporter }];
}
export function describeTestEnvironment(config: RunnerConfig) {
  return { commands: testCommands(config).map(step => ({ name: step.name, cwd: step.cwd, command: step.command,
    reporter: step.reporter, environmentVariables: Object.keys({ ...config.env, ...step.env }).sort() })),
    services: (config.services ?? []).map(service => service.name) };
}
