import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Experience, GoalState } from '../../domain/iteration.js';
import type { IterationStore } from '../../ports/iteration.js';

/** All mutations except pause() run under the controller's existing exclusive lock. */
export class FileIterationStore implements IterationStore {
  private root: string;
  constructor(dataDir: string) { this.root = join(dataDir, 'goals'); }
  private valid(id: string) { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid goal ID.'); }
  private async readJson<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.root, name), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async write(name: string, value: unknown) {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, name + '.' + randomUUID() + '.tmp'), file = await open(temp, 'wx');
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(this.root, name));
  }
  async read(id: string) { this.valid(id); return this.readJson<GoalState>(id + '.json'); }
  async save(state: GoalState) { this.valid(state.id); await this.write(state.id + '.json', state); }
  private async names() {
    return readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  }
  async list() {
    const states: GoalState[] = [];
    for (const name of (await this.names()).filter(n => /^[a-f0-9]{24}\.json$/.test(n))) {
      const state = await this.read(name.slice(0, -5)); if (state) states.push(state);
    }
    return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async pause(id: string) { this.valid(id); if (!await this.read(id)) throw new Error('Goal not found.'); await this.write(id + '.pause', { at: new Date().toISOString() }); }
  async paused(id: string) { this.valid(id); return !!await this.readJson(id + '.pause'); }
  async unpause(id: string) { this.valid(id); await unlink(join(this.root, id + '.pause')).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
  async remember(entry: Experience) { this.valid(entry.id); await this.write(entry.id + '.experience.json', entry); }
  async experiences() {
    const entries: Experience[] = [];
    for (const name of (await this.names()).filter(n => /^[a-f0-9]{24}\.experience\.json$/.test(n))) {
      const entry = await this.readJson<Experience>(name); if (entry) entries.push(entry);
    }
    return entries;
  }
}
