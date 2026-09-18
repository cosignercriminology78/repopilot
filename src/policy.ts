import { z } from 'zod';
import { safePath } from './git.js';
import type { Finding, Snapshot } from './types.js';

export const policySchema = z.object({ rules: z.array(z.object({
  id: z.string().min(1), scope: z.string().default(''),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i)).default([]),
  forbiddenText: z.string().min(1), caseInsensitive: z.boolean().default(false),
  message: z.string().min(1), severity: z.enum(['error', 'warning']).default('error')
}).strict()).max(100) }).strict();
export type Policy = z.infer<typeof policySchema>;
export function loadPolicy(base: Snapshot): Policy {
  const policy = policySchema.parse(JSON.parse(base.get('.repopilot/policy.json') ?? '{"rules":[]}'));
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) throw new Error('Duplicate rule ID.');
    ids.add(rule.id);
    if (rule.scope && !safePath(rule.scope)) throw new Error('Unsafe rule scope.');
  }
  return policy;
}
export function instructions(base: Snapshot, path: string): { path: string; content: string }[] {
  return [...base].filter(([key]) => key === 'AGENTS.md' || key.endsWith('/AGENTS.md'))
    .filter(([key]) => key === 'AGENTS.md' || path.startsWith(key.slice(0, -'AGENTS.md'.length)))
    .sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map(([path, content]) => ({ path, content }));
}
export function checkPolicy(files: Snapshot, policy: Policy): Finding[] {
  const findings: Finding[] = [];
  for (const [path, content] of files) for (const rule of policy.rules) {
    if (path === '.repopilot/policy.json') continue;
    if (rule.scope && path !== rule.scope && !path.startsWith(`${rule.scope}/`)) continue;
    if (rule.extensions.length && !rule.extensions.some(ext => path.endsWith(ext))) continue;
    content.split('\n').forEach((line, index) => {
      const text = rule.caseInsensitive ? line.toLowerCase() : line;
      const forbidden = rule.caseInsensitive ? rule.forbiddenText.toLowerCase() : rule.forbiddenText;
      if (text.includes(forbidden)) findings.push({ ruleId: rule.id, path, line: index + 1, message: rule.message,
        source: `.repopilot/policy.json#${rule.id}`, severity: rule.severity, kind: 'static' });
    });
  }
  return findings;
}
// Compare occurrences by rule/path/line content, so inserting unrelated lines does not turn old issues into new ones.
export function introducedFindings(base: Snapshot, head: Snapshot, policy: Policy): { findings: Finding[]; historical: Finding[] } {
  const fingerprint = (f: Finding, files: Snapshot) => JSON.stringify([f.ruleId, f.path, files.get(f.path)?.split('\n')[f.line - 1]?.trim()]);
  const counts = new Map<string, number>();
  for (const f of checkPolicy(base, policy)) { const key = fingerprint(f, base); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const findings: Finding[] = [], historical: Finding[] = [];
  for (const f of checkPolicy(head, policy)) {
    const key = fingerprint(f, head), n = counts.get(key) ?? 0;
    if (n > 0) { historical.push(f); counts.set(key, n - 1); } else findings.push(f);
  }
  return { findings, historical };
}
