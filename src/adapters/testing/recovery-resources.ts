import type { OwnedResource, RecoveryResources } from '../../ports/recovery.js';
import { execute } from '../../shared/process.js';
import { resourceOwner } from '../../shared/resource-owner.js';

export class DockerRecoveryResources implements RecoveryResources {
  constructor(private root: string, private run = execute) {}
  private async command(args: string[]): Promise<string> {
    const result = await this.run('docker', args, { timeoutMs: 15000 });
    if (result.code !== 0 || result.timedOut) throw new Error('Docker recovery operation failed: ' + args.slice(0, 2).join(' '));
    return result.stdout;
  }
  private async inspect(kind: OwnedResource['kind'], id: string, owner: string): Promise<OwnedResource> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Docker resource ID.');
    const rows = JSON.parse(await this.command([kind, 'inspect', id]));
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Ambiguous Docker resource.');
    const row = rows[0], labels = kind === 'container' ? row.Config?.Labels : row.Labels;
    const name = typeof row.Name === 'string' ? row.Name.replace(/^\//, '') : '';
    if (row.Id !== id || labels?.['io.repopilot.managed'] !== 'true' || labels?.['io.repopilot.owner'] !== owner
      || !/^repopilot-(test|agent)-[a-f0-9-]{36}(?:-[a-z0-9-]+)?$/.test(name)) throw new Error('Docker resource ownership cannot be confirmed.');
    return { kind, id, name };
  }
  async list(): Promise<OwnedResource[]> {
    const owner = await resourceOwner(this.root), resources: OwnedResource[] = [];
    for (const kind of ['container', 'network'] as const) {
      const result = await this.command([kind, 'ls', '-q', '--no-trunc', ...(kind === 'container' ? ['-a'] : []),
        '--filter', 'label=io.repopilot.managed=true', '--filter', 'label=io.repopilot.owner=' + owner]);
      for (const id of new Set(result.trim().split(/\s+/).filter(Boolean))) resources.push(await this.inspect(kind, id, owner));
    }
    return resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }
  async remove(resource: OwnedResource): Promise<void> {
    const current = await this.inspect(resource.kind, resource.id, await resourceOwner(this.root));
    if (current.name !== resource.name) throw new Error('Docker resource changed since preview.');
    // Docker refuses to remove a network while any endpoints remain. Never disconnect unrelated containers.
    await this.command(resource.kind === 'container' ? ['container', 'rm', '-f', '-v', resource.id] : ['network', 'rm', resource.id]);
  }
}
