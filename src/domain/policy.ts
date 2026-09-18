import ts from 'typescript';
import { z } from 'zod';
import { safePath } from './snapshot.js';
import type { Finding, Report, Snapshot } from './types.js';

const ruleSchema = z.object({
  id: z.string().min(1), scope: z.string().default(''), extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i)).default([]),
  kind: z.enum(['literal', 'forbid-call', 'require-call']).default('literal'),
  forbiddenText: z.string().min(1).optional(), callee: z.string().regex(/^[\w$]+(?:\.[\w$]+)*$/).optional(),
  caseInsensitive: z.boolean().default(false), message: z.string().min(1),
  severity: z.enum(['error', 'warning']).default('error')
}).strict().superRefine((rule, ctx) => {
  if (rule.kind === 'literal' ? !rule.forbiddenText : !rule.callee) ctx.addIssue({ code: 'custom', message: 'Rule requires forbiddenText or AST callee.' });
});
export const policySchema = z.object({
  rules: z.array(ruleSchema).max(100),
  exceptions: z.array(z.object({ ruleId: z.string().min(1), path: z.string().min(1),
    reason: z.string().min(3), expiresAt: z.iso.datetime(), evidence: z.string().min(1).optional()
  }).strict()).max(100).default([])
}).strict();
export type Policy = z.infer<typeof policySchema>;
export function loadPolicy(base: Snapshot): Policy {
  const policy = policySchema.parse(JSON.parse(base.get('.repopilot/policy.json') ?? '{"rules":[]}'));
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) throw new Error('Duplicate rule ID.');
    ids.add(rule.id);
    if (rule.scope && !safePath(rule.scope)) throw new Error('Unsafe rule scope.');
  }
  for (const item of policy.exceptions) if (!safePath(item.path)) throw new Error('Unsafe exception path.');
  for (const a of policy.rules) for (const b of policy.rules) {
    const overlap = !a.scope || !b.scope || a.scope === b.scope || a.scope.startsWith(b.scope + '/') || b.scope.startsWith(a.scope + '/');
    const extensions = !a.extensions.length || !b.extensions.length || a.extensions.some(ext => b.extensions.includes(ext));
    if (a.kind === 'require-call' && b.kind === 'forbid-call' && a.callee === b.callee && overlap && extensions) {
      throw new Error(`Conflicting rules: ${a.id} requires ${a.callee}, while ${b.id} forbids it.`);
    }
  }
  return policy;
}
export function instructions(base: Snapshot, path: string): { path: string; content: string }[] {
  return [...base].filter(([key]) => key === 'AGENTS.md' || key.endsWith('/AGENTS.md'))
    .filter(([key]) => key === 'AGENTS.md' || path.startsWith(key.slice(0, -'AGENTS.md'.length)))
    .sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map(([path, content]) => ({ path, content }));
}
function callName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) { const root = callName(node.expression); return root ? root + '.' + node.name.text : undefined; }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    const root = callName(node.expression); return root ? root + '.' + node.argumentExpression.text : undefined;
  }
  return undefined;
}
export function checkPolicy(files: Snapshot, policy: Policy): Finding[] {
  const findings: Finding[] = [];
  for (const [path, content] of files) {
    const rules = policy.rules.filter(rule => path !== '.repopilot/policy.json'
      && (!rule.scope || path === rule.scope || path.startsWith(rule.scope + '/'))
      && (!rule.extensions.length || rule.extensions.some(ext => path.endsWith(ext))));
    const emit = (rule: Policy['rules'][number], line: number) => findings.push({
      ruleId: rule.id, path, line, message: rule.message, source: '.repopilot/policy.json#' + rule.id,
      severity: rule.severity, kind: 'static', evidence: content.split('\n')[line - 1] ?? ''
    });
    for (const rule of rules.filter(r => r.kind === 'literal')) {
      content.split('\n').forEach((line, index) => {
        if ((rule.caseInsensitive ? line.toLowerCase() : line).includes(rule.caseInsensitive ? rule.forbiddenText!.toLowerCase() : rule.forbiddenText!)) emit(rule, index + 1);
      });
    }
    const astRules = rules.filter(r => r.kind !== 'literal');
    if (!astRules.length || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) {
      findings.push({ ruleId: 'syntax-error', path, line: source.getLineAndCharacterOfPosition(diagnostics[0]?.start ?? 0).line + 1,
        message: 'AST policy cannot inspect a syntactically invalid file.', source: '.repopilot/policy.json', severity: 'error', kind: 'static' });
      continue;
    }
    const calls = new Map<string, number[]>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (name) calls.set(name, [...(calls.get(name) ?? []), source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const rule of astRules) {
      const lines = calls.get(rule.callee!) ?? [];
      if (rule.kind === 'require-call' && !lines.length) emit(rule, 1);
      if (rule.kind === 'forbid-call') for (const line of lines) emit(rule, line);
    }
  }
  return findings;
}
export function findingKey(f: Finding, files: Snapshot): string {
  return JSON.stringify([f.ruleId, f.path, f.source, f.ruleQuote?.replace(/\s+/g, ' ').trim(),
    f.evidence?.trim() ?? files.get(f.path)?.split('\n')[f.line - 1]?.trim()]);
}
export function partitionFindings(before: Finding[], after: Finding[], base: Snapshot, head: Snapshot) {
  const counts = new Map<string, number>();
  for (const f of before) { const key = findingKey(f, base); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const findings: Finding[] = [], historical: Finding[] = [];
  for (const f of after) {
    const key = findingKey(f, head), n = counts.get(key) ?? 0;
    if (n > 0) { historical.push(f); counts.set(key, n - 1); } else findings.push(f);
  }
  return { findings, historical };
}
export function introducedFindings(base: Snapshot, head: Snapshot, policy: Policy) {
  return partitionFindings(checkPolicy(base, policy), checkPolicy(head, policy), base, head);
}
export function applyExceptions(findings: Finding[], policy: Policy, now = new Date()) {
  const active: Finding[] = [], suppressed: Report['suppressed'] = [];
  for (const finding of findings) {
    const exception = policy.exceptions.find(e => e.ruleId === finding.ruleId && e.path === finding.path
      && new Date(e.expiresAt) > now && (!e.evidence || e.evidence === finding.evidence));
    if (exception) suppressed.push({ finding, reason: exception.reason, expiresAt: exception.expiresAt });
    else active.push(finding);
  }
  return { findings: active, suppressed };
}
