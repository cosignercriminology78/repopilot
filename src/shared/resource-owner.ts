import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';

export async function resourceOwner(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = await realpath(root);
  return createHash('sha256').update(hostname() + '\n' + (process.platform === 'win32' ? path.toLowerCase() : path)).digest('hex');
}
export const ownerLabels = (owner: string) => ['--label', 'io.repopilot.managed=true', '--label', 'io.repopilot.owner=' + owner];
