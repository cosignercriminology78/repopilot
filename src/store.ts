import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from './types.js';

export function taskId(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24); }
export class Store {
  constructor(readonly root: string) {}
  async acquire(): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, 'controller.lock');
    const lock = await open(path, 'wx').catch(() => { throw new Error(`Controller lock exists: ${path}. Stop the other controller; after a crash, verify it stopped before removing this lock.`); });
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.close();
    return () => unlink(path);
  }
  async read(id: string): Promise<Report | undefined> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid task ID.');
    try { return JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async save(report: Report): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, `${report.id}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx');
    try { await file.writeFile(JSON.stringify(report, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(this.root, `${report.id}.json`));
  }
}
