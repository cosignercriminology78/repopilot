import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { RecoveryLock, LockState } from '../../ports/recovery.js';
import { pause } from '../../shared/control.js';

export class ControllerLock implements RecoveryLock {
  constructor(private root: string, private alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined; }
  }) {}
  private async raw(): Promise<string | undefined> {
    try { return await readFile(join(this.root, 'controller.lock'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async inspect(): Promise<LockState> {
    const raw = await this.raw();
    if (raw === undefined) return { status: 'absent', fingerprint: 'absent' };
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    try {
      const record = JSON.parse(raw);
      if (record.schemaVersion !== 1 || record.hostname !== hostname() || !Number.isSafeInteger(record.pid) || record.pid <= 0
        || typeof record.owner !== 'string' || !record.owner) return { status: 'unknown', fingerprint };
      const alive = this.alive(record.pid);
      return { status: alive === false ? 'stale' : alive === true ? 'active' : 'unknown', fingerprint };
    } catch { return { status: 'unknown', fingerprint }; }
  }
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, 'controller.guard');
    const acquireGate = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await open(path, 'wx'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (attempt >= 20) throw new Error('Controller lock operation in progress, or controller.guard needs manual crash inspection.');
          await pause(25);
        }
      }
    };
    const gate = await acquireGate();
    try { await gate.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() })); return await work(); }
    finally { await gate.close(); await unlink(path); }
  }
  async acquire(expected?: string): Promise<() => Promise<void>> {
    const owner = randomUUID();
    await this.guarded(async () => {
      const state = await this.inspect();
      if (expected !== undefined) {
        if (state.fingerprint !== expected || !['absent', 'stale'].includes(state.status)) throw new Error('Controller lock changed or is not safely recoverable.');
        if (state.status === 'stale') await unlink(join(this.root, 'controller.lock'));
      } else if (state.status !== 'absent') throw new Error('Controller lock exists; use recover to inspect it.');
      const lock = await open(join(this.root, 'controller.lock'), 'wx');
      try { await lock.writeFile(JSON.stringify({ schemaVersion: 1, owner, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })); await lock.sync(); }
      finally { await lock.close(); }
    });
    return () => this.guarded(async () => {
      const raw = await this.raw();
      if (!raw || JSON.parse(raw).owner !== owner) throw new Error('Controller lock ownership changed; refusing release.');
      await unlink(join(this.root, 'controller.lock'));
    });
  }
}
