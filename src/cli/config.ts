import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema, type Config } from '../domain/config.js';
import { testCommands } from '../domain/runner-config.js';

export async function loadConfig(path: string): Promise<Config> {
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.dataDir = resolve(config.dataDir);
  if (config.publish && (!config.agent.enabled || !config.agent.repair || !config.runner)) {
    throw new Error('Publishing requires agent.enabled, agent.repair and a test runner.');
  }
  if (config.publish && config.runner && testCommands(config.runner).some(step => step.reporter === 'command')) {
    throw new Error('Publishing requires a structured test reporter for every command.');
  }
  return config;
}
