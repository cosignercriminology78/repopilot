import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Answer } from '../../domain/agent-answer.js';
import { answerSchema } from '../../domain/agent-answer.js';
import type { Config } from '../../domain/config.js';
import type { Snapshot } from '../../domain/types.js';
import type { Agent } from '../../ports/agent.js';
import { RetryableError, throwIfAborted } from '../../shared/control.js';
import { execute } from '../../shared/process.js';
import { contextBatches } from './context.js';

export class DockerCodexAgent implements Agent {
  private calls = 0;
  private tokens = 0;
  constructor(private config: Config['agent'], private dataDir: string) {}
  resetBudget() { this.calls = 0; this.tokens = 0; }
  usage() { return { calls: this.calls, tokens: this.tokens }; }
  review(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, paths?: string[]) { return this.call('review', base, head, description, signal, paths); }
  plan(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal) { return this.call('plan', base, head, description, signal); }
  repair(base: Snapshot, head: Snapshot, evidence: string, signal?: AbortSignal) { return this.call('repair', base, head, evidence, signal); }
  private async call(mode: string, base: Snapshot, head: Snapshot, context: string, signal?: AbortSignal, paths?: string[]): Promise<Answer> {
    if (!process.env.OPENAI_API_KEY) throw new Error('Agent container requires OPENAI_API_KEY.');
    const batches = contextBatches(base, head, paths);
    const combined: Answer = { findings: [], changes: [], scenarios: [], summary: '' };
    for (const batch of batches) {
      throwIfAborted(signal);
      if (this.calls >= this.config.maxCalls || this.tokens >= this.config.maxTokens) throw new Error('Agent task budget exhausted.');
      this.calls++;
      const input = JSON.stringify({ mode, model: this.config.model, context, ...batch });
      if (Buffer.byteLength(input) > 500000) throw new Error('Evidence/context exceeds per-call budget.');
      const name = 'repopilot-agent-' + randomUUID(), root = resolve(this.dataDir, 'work', name);
      await mkdir(root, { recursive: true }); await writeFile(resolve(root, 'input.json'), input);
      try {
        const result = await execute('docker', ['run', '--rm', '--name', name, '--read-only',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '2g', '--cpus', '2',
          '--user', '65534:65534', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
          '--mount', `type=bind,source=${root},target=/input,readonly`,
          '-e', 'OPENAI_API_KEY', '-e', 'CODEX_HOME=/tmp/codex', '-e', 'HOME=/tmp', this.config.image],
          { timeoutMs: this.config.timeoutSeconds * 1000, signal });
        if (result.code === 125 || result.timedOut) throw new RetryableError('Codex container was unavailable or timed out.');
        if (result.code !== 0) throw new Error('Codex container failed: ' + result.stderr.slice(-2000));
        const envelope = z.object({ answer: answerSchema, tokens: z.number().int().nonnegative() }).parse(JSON.parse(result.stdout));
        this.tokens += envelope.tokens;
        if (this.tokens > this.config.maxTokens) throw new Error('Agent task token budget exceeded; further calls blocked.');
        for (const change of envelope.answer.changes) {
          if (mode === 'repair' && head.has(change.path) && !batch.diff.some(f => f.path === change.path) && !batch.files.some(f => f.path === change.path)) {
            throw new Error('Repair targets a file outside supplied context: ' + change.path);
          }
          const previous = combined.changes.find(c => c.path === change.path);
          if (previous && previous.content !== change.content) throw new Error('Conflicting edits across context batches: ' + change.path);
          if (!previous) combined.changes.push(change);
        }
        combined.findings.push(...envelope.answer.findings); combined.scenarios.push(...envelope.answer.scenarios);
        combined.summary += envelope.answer.summary + '\n';
      } finally { await execute('docker', ['rm', '-f', name], { timeoutMs: 10000 }).catch(() => undefined); }
    }
    return combined;
  }
}
