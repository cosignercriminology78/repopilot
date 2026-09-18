import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema, type Config } from '../domain/config.js';

export async function loadConfig(path: string): Promise<Config> {
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.dataDir = resolve(config.dataDir);
  if (config.publish && (!config.agent.enabled || !config.agent.repair || !config.runner)) {
    throw new Error('Publishing requires agent.enabled, agent.repair and a test runner.');
  }
  if (config.runner?.reporter === 'node' && (config.runner.command[0] !== 'node' || !config.runner.command.includes('--test'))) {
    throw new Error('The node reporter requires a node --test command.');
  }
  if (config.publish && config.runner?.reporter === 'command') throw new Error('Publishing requires a structured node or vitest reporter.');
  return config;
}
