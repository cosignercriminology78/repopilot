import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Finding, RepairChange, Snapshot, TestPlan } from './types.js';
import { execute } from './process.js';
import { changedPaths, safePath, copySnapshot } from './git.js';
import { instructions, checkPolicy, policySchema } from './policy.js';
import { contextBatches } from './context.js';
import { throwIfAborted, RetryableError } from './control.js';

export const answerSchema = z.object({
  findings: z.array(z.object({
    ruleId: z.string().min(1), path: z.string(), line: z.number().int().positive(),
    message: z.string().min(1), source: z.string(), severity: z.enum(['error', 'warning']),
    ruleQuote: z.string().min(3), evidence: z.string().min(1)
  }).strict()).max(100),
  changes: z.array(z.object({ path: z.string(), content: z.string().max(200000) }).strict()).max(20),
  scenarios: z.array(z.object({ name: z.string().min(1), requirement: z.string().min(1), testFile: z.string() }).strict()).max(50),
  summary: z.string()
}).strict();
export type Answer = z.infer<typeof answerSchema>;
export interface Agent {
  review(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal, paths?: string[]): Promise<Answer>;
  plan(base: Snapshot, head: Snapshot, description: string, signal?: AbortSignal): Promise<Answer>;
  repair(base: Snapshot, head: Snapshot, evidence: string, signal?: AbortSignal): Promise<Answer>;
  resetBudget?(): void;
  usage?(): { calls: number; tokens: number };
}
export function protectedPath(path: string): boolean {
  return /(^|\/)(AGENTS\.md|CLAUDE\.md|package[^/]*\.json|[^/]*lock[^/]*|[^/]*config[^/]*|Dockerfile[^/]*|Makefile|go\.mod|go\.sum|Cargo\.toml|pyproject\.toml)$/i.test(path)
    || path.split('/').some(segment => segment.startsWith('.'));
}
export function isTest(path: string): boolean { return /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.|_test\.go$|(^|\/)test_[^/]+\.py$/i.test(path); }
export function applyChanges(head: Snapshot, changes: RepairChange[]): Snapshot {
  if (!changes.length) throw new Error('Agent proposed no changes.');
  const result = copySnapshot(head), seen = new Set<string>();
  const portable = new Set([...head.keys()].map(p => p.toLowerCase()));
  for (const change of changes) {
    if (!safePath(change.path) || protectedPath(change.path) || (head.has(change.path) && isTest(change.path))
      || !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|sql|vue|css)$/.test(change.path)) {
      throw new Error('Repair cannot modify protected/unsupported path: ' + change.path);
    }
    if (seen.has(change.path) || (!head.has(change.path) && portable.has(change.path.toLowerCase()))) throw new Error('Duplicate or case-colliding repair path.');
    if (change.content.includes('\0') || Buffer.byteLength(change.content) > 200000) throw new Error('Binary/oversized repair not allowed.');
    seen.add(change.path); portable.add(change.path.toLowerCase()); result.set(change.path, change.content);
  }
  return result;
}
export function validatePlan(answer: Answer, head: Snapshot): TestPlan {
  if (!answer.scenarios.length || !answer.changes.length) throw new Error('Agent did not provide executable tests and scenarios.');
  const paths = new Set(answer.changes.map(c => c.path));
  if (answer.changes.some(c => head.has(c.path) || !isTest(c.path) || !/\.[cm]?[jt]sx?$/.test(c.path))) {
    throw new Error('Test planning may only add JavaScript/TypeScript test files.');
  }
  if (answer.scenarios.some(s => !paths.has(s.testFile)) || [...paths].some(p => !answer.scenarios.some(s => s.testFile === p))) {
    throw new Error('Every generated test file must map to a planned scenario.');
  }
  applyChanges(head, answer.changes);
  const testFiles = new Map(answer.changes.map(c => [c.path, c.content]));
  const policy = policySchema.parse({ rules: ['test', 'it', 'describe'].flatMap(fn => ['skip', 'todo', 'only'].map(modifier => ({
    id: fn + '-' + modifier, kind: 'forbid-call', callee: fn + '.' + modifier, message: 'Generated tests cannot skip, focus or remain TODO.'
  }))) });
  if (checkPolicy(testFiles, policy).length) throw new Error('Generated tests contain disabled/focused tests or invalid syntax.');
  return { summary: answer.summary, scenarios: answer.scenarios, tests: answer.changes };
}
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
export function semanticFindings(answer: Answer, base: Snapshot, head: Snapshot, paths = changedPaths(base, head)): Finding[] {
  const allowed = new Set(paths);
  return answer.findings.map(f => {
    const source = instructions(base, f.path).find(rule => rule.path === f.source);
    const content = head.get(f.path), line = content?.split('\n')[f.line - 1];
    if (!allowed.has(f.path) || line === undefined || !source
      || !normalize(source.content).includes(normalize(f.ruleQuote))
      || !normalize(content!).includes(normalize(f.evidence))
      || !normalize(f.evidence).includes(normalize(line)) || !line.trim()) {
      throw new Error('Agent finding lacks a valid scoped rule quote or code evidence.');
    }
    return { ...f, kind: 'semantic' as const };
  });
}
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
