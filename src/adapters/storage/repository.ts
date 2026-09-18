import { mkdir, stat } from 'node:fs/promises';
import type { Repository } from '../../ports/repository.js';
import { checked } from '../../shared/process.js';
import { resolveCommit, snapshot } from './git.js';
export const gitRepository: Repository = {
  resolveCommit, snapshot,
  async prepare(repo) {
    if (!await stat(repo).catch(() => undefined)) {
      await mkdir(repo, { recursive: true });
      await checked('git', ['init', '--bare', repo]);
    }
  },
  async fetch(repo, repository, base, head, signal) {
    await checked('git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags',
      'https://github.com/' + repository + '.git', base, head], repo, signal);
  }
};
