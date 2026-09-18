import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from '../../domain/types.js';
import type { Store as TaskStore } from '../../ports/store.js';
import { markdownReport } from '../../reporting/markdown.js';

export class Store implements TaskStore {
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
  async list(): Promise<Report[]> {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const reports: Report[] = [];
    for (const name of names.filter(n => /^[a-f0-9]{24}\.json$/.test(n))) {
      const report = await this.read(name.slice(0, -5));
      if (report) reports.push(report);
    }
    return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async requestCancellation(id: string): Promise<void> {
    const report = await this.read(id);
    if (!report) throw new Error('Task not found: ' + id);
    if (report.status === 'published') throw new Error('Published tasks cannot be cancelled.');
    await this.write(id + '.cancel.json', JSON.stringify({ requestedAt: new Date().toISOString() }));
  }
  async cancellationRequested(id: string): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid task ID.');
    try { await readFile(join(this.root, id + '.cancel.json')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  /** Only the controller holding acquire() may resume and clear cancellation intent. */
  async clearCancellation(id: string): Promise<void> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid task ID.');
    await unlink(join(this.root, id + '.cancel.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async save(report: Report): Promise<void> {
    if (!/^[a-f0-9]{24}$/.test(report.id)) throw new Error('Invalid task ID.');
    await mkdir(this.root, { recursive: true });
    await this.write(report.id + '.md', markdownReport(report));
    await this.write(report.id + '.json', JSON.stringify(report, null, 2));
  }
  async archive(report: Report): Promise<void> {
    if (!/^[a-f0-9]{24}$/.test(report.id) || !Number.isInteger(report.executions) || report.executions < 1) throw new Error('Invalid report archive.');
    await this.write(report.id + '.execution-' + report.executions + '.json', JSON.stringify(report, null, 2));
  }
  private async write(name: string, content: string): Promise<void> {
    const temp = join(this.root, `${name}.${randomUUID()}.tmp`);
    const file = await open(temp, 'wx');
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(this.root, name));
  }
}
