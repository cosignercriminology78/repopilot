import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Finding, RepairChange, Snapshot } from './types.js';
import { execute } from './process.js';
import { changedPaths, safePath } from './git.js';
import { instructions } from './policy.js';

export const answerSchema = z.object({
  findings: z.array(z.object({ ruleId: z.string(), path: z.string(), line: z.number().int().positive(),
    message: z.string(), source: z.string(), severity: z.enum(['error', 'warning']) }).strict()).max(100),
  changes: z.array(z.object({ path: z.string(), content: z.string().max(200000) }).strict()).max(20),
  summary: z.string()
}).strict();
export type Answer = z.infer<typeof answerSchema>;
export interface Agent {
  review(base: Snapshot, head: Snapshot, description: string): Promise<Answer>;
  repair(base: Snapshot, head: Snapshot, evidence: string): Promise<Answer>;
}
export function protectedPath(path: string): boolean {
  return /(^|\/)(AGENTS\.md|CLAUDE\.md|package[^/]*\.json|[^/]*lock[^/]*|[^/]*config[^/]*|Dockerfile[^/]*|Makefile|go\.mod|go\.sum|Cargo\.toml|pyproject\.toml)$/i.test(path)
    || path.split('/').some(segment => segment.startsWith('.'));
}
export function isTest(path: string): boolean { return /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.|_test\.go$|(^|\/)test_[^/]+\.py$/i.test(path); }
export function applyChanges(head: Snapshot, changes: RepairChange[]): Snapshot {
  if (!changes.length) throw new Error('Agent proposed no changes.');
  const result = new Map(head), seen = new Set<string>();
  for (const change of changes) {
    if (!safePath(change.path) || protectedPath(change.path) || (head.has(change.path) && isTest(change.path))
      || !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|sql|vue|css)$/.test(change.path)) {
      throw new Error(`Repair cannot modify protected/unsupported path: ${change.path}`);
    }
    if (seen.has(change.path)) throw new Error('Duplicate repair path.');
    if (change.content.includes('\0')) throw new Error('Binary repair not allowed.');
    seen.add(change.path); result.set(change.path, change.content);
  }
  return result;
}
export function semanticFindings(answer: Answer, base: Snapshot, head: Snapshot): Finding[] {
  const changed = new Set(changedPaths(base, head));
  return answer.findings.map(f => {
    if (!changed.has(f.path) || !head.has(f.path) || f.line > head.get(f.path)!.split('\n').length
      || !instructions(base, f.path).some(rule => rule.path === f.source)) {
      throw new Error('Agent finding lacks a valid changed-file location or trusted AGENTS.md source.');
    }
    return { ...f, kind: 'semantic' as const };
  });
}
export class DockerCodexAgent implements Agent {
  constructor(private config: Config['agent'], private dataDir: string) {}
  review(base: Snapshot, head: Snapshot, description: string) { return this.call('review', base, head, description); }
  repair(base: Snapshot, head: Snapshot, evidence: string) { return this.call('repair', base, head, evidence); }
  private async call(mode: string, base: Snapshot, head: Snapshot, context: string): Promise<Answer> {
    if (!process.env.OPENAI_API_KEY) throw new Error('Agent container requires OPENAI_API_KEY.');
    const changes = changedPaths(base, head);
    const input = JSON.stringify({ mode, model: this.config.model, context,
      files: [...head].map(([path, content]) => ({ path, content })),
      diff: changes.map(path => ({ path, before: base.get(path), after: head.get(path), rules: instructions(base, path) })) });
    if (Buffer.byteLength(input) > 500_000) throw new Error('Agent context exceeds MVP limit (500 KB). Narrow the repository.');
    const name = `repopilot-agent-${randomUUID()}`, root = resolve(this.dataDir, 'work', name);
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, 'input.json'), input);
    try {
      const result = await execute('docker', ['run', '--rm', '--name', name, '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
        '--memory', '2g', '--cpus', '2', '--user', '65534:65534',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--mount', `type=bind,source=${root},target=/input,readonly`,
        '-e', 'OPENAI_API_KEY', '-e', 'CODEX_HOME=/tmp/codex', '-e', 'HOME=/tmp',
        this.config.image], { timeoutMs: this.config.timeoutSeconds * 1000 });
      if (result.code !== 0 || result.timedOut) throw new Error(`Codex container failed: ${result.stderr.slice(-2000)}`);
      return answerSchema.parse(JSON.parse(result.stdout));
    } finally { await execute('docker', ['rm', '-f', name], { timeoutMs: 10000 }).catch(() => undefined); }
  }
}
