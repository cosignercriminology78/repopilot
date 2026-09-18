import type { TestService } from '../../domain/runner-config.js';
import { pause, RetryableError, throwIfAborted } from '../../shared/control.js';
import { execute } from '../../shared/process.js';
import { ownerLabels } from '../../shared/resource-owner.js';
export type DockerExecute = typeof execute;
export class DependencyStoppedError extends Error {}

export class DockerEnvironment {
  private network?: string;
  private containers: string[] = [];
  constructor(private run: DockerExecute) {}
  async start(prefix: string, services: TestService[], signal: AbortSignal, owner: string): Promise<string> {
    if (!services.length) return 'none';
    this.network = prefix + '-network';
    await this.checked(['network', 'create', '--internal', ...ownerLabels(owner), '--label', 'repopilot.run=' + prefix, this.network], signal);
    for (const service of services) {
      throwIfAborted(signal);
      const name = prefix + '-service-' + service.name;
      const [uid, gid] = service.user.split(':');
      this.containers.push(name);
      await this.checked(['run', '--detach', '--pull=never', '--name', name, '--network', this.network,
        ...ownerLabels(owner),
        '--network-alias', service.name, '--label', 'repopilot.run=' + prefix,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
        '--user', service.user, '--memory', service.memory, '--cpus', String(service.cpus),
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
        ...service.tmpfs.flatMap(path => ['--tmpfs', path + ':rw,nosuid,nodev,size=256m,mode=1777,uid=' + uid + ',gid=' + gid]),
        ...Object.entries(service.env).flatMap(([key, value]) => ['--env', key + '=' + value]),
        service.image, ...(service.command ?? [])], signal);
      const ready = AbortSignal.any([signal, AbortSignal.timeout(service.readiness.timeoutSeconds * 1000)]);
      for (;;) {
        ready.throwIfAborted();
        const probe = await this.run('docker', ['exec', name, ...service.readiness.command], { signal: ready, timeoutMs: 10000 });
        if (probe.code === 0 && !probe.timedOut) break;
        await this.assertRunning(signal);
        await pause(250, ready);
      }
    }
    return this.network;
  }
  async assertRunning(signal: AbortSignal): Promise<void> {
    for (const name of this.containers) {
      const state = await this.run('docker', ['inspect', '--format', '{{.State.Running}}', name], { signal, timeoutMs: 10000 });
      if (state.code !== 0 || state.timedOut || state.stdout.trim() !== 'true') throw new DependencyStoppedError('Dependency service stopped: ' + name);
    }
  }
  private async checked(args: string[], signal: AbortSignal): Promise<void> {
    const result = await this.run('docker', args, { signal, timeoutMs: 30000 });
    if (result.code !== 0 || result.timedOut) throw new RetryableError('Docker dependency setup failed: ' + args[0]);
  }
  async cleanup(): Promise<string[]> {
    const errors: string[] = [];
    for (const args of [
      ...[...this.containers].reverse().map(name => ['rm', '-f', '-v', name]),
      ...(this.network ? [['network', 'rm', this.network]] : [])
    ]) {
      try {
        const result = await this.run('docker', args, { timeoutMs: 10000 });
        if (result.timedOut || (result.code !== 0 && !/No such (container|network)/i.test(result.stderr))) errors.push('Cleanup failed: ' + args.join(' '));
      } catch { errors.push('Cleanup failed: ' + args.join(' ')); }
    }
    return errors;
  }
}
