import type { Answer } from './agent-answer.js';
import { checkPolicy, instructions, policySchema } from './policy.js';
import { changedPaths, copySnapshot, safePath } from './snapshot.js';
import type { Finding, RepairChange, Snapshot, TestPlan } from './types.js';

export function protectedPath(path: string): boolean {
  return /(^|\/)(AGENTS\.md|CLAUDE\.md|package[^/]*\.json|[^/]*lock[^/]*|[^/]*config[^/]*|Dockerfile[^/]*|Makefile|go\.mod|go\.sum|Cargo\.toml|pyproject\.toml|conftest\.py|setup\.(py|cfg)|requirements[^/]*\.txt|pytest\.ini|tox\.ini|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/i.test(path)
    || path.split('/').some(segment => segment.startsWith('.'));
}
export function isTest(path: string): boolean { return /(^|\/)(tests?|__tests__)\/|[._](test|spec)\.|_test\.go$|(^|\/)test_[^/]+\.py$|Test(s)?\.java$/i.test(path); }
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
export function validatePlan(answer: Answer, head: Snapshot, description = ''): TestPlan {
  if (!answer.scenarios.length || !answer.changes.length) throw new Error('Agent did not provide executable tests and scenarios.');
  const paths = new Set(answer.changes.map(c => c.path));
  if (answer.changes.some(c => head.has(c.path) || !isTest(c.path) || !/(\.[cm]?[jt]sx?|\.py|\.go|\.java)$/.test(c.path))) {
    throw new Error('Test planning may only add supported test files.');
  }
  if (answer.scenarios.some(s => !paths.has(s.testFile)) || [...paths].some(p => !answer.scenarios.some(s => s.testFile === p))) {
    throw new Error('Every generated test file must map to a planned scenario.');
  }
  const scenarios = answer.scenarios.map(s => ({ ...s, kind: s.kind ?? 'regression' as const }));
  for (const scenario of scenarios) {
    if (scenario.kind === 'new_behavior' && (!scenario.requirementQuote || scenario.requirementQuote.trim().length < 8
      || !normalize(description).includes(normalize(scenario.requirementQuote)))) {
      throw new Error('New behavior requires an exact requirement quote from the PR description.');
    }
    if (scenarios.some(other => other.testFile === scenario.testFile && other.kind !== scenario.kind)) {
      throw new Error('Separate new behavior and regression scenarios into different test files.');
    }
  }
  applyChanges(head, answer.changes);
  const testFiles = new Map(answer.changes.filter(c => /\.[cm]?[jt]sx?$/.test(c.path)).map(c => [c.path, c.content]));
  for (const change of answer.changes) {
    if ((change.path.endsWith('.py') && /\b(skip|skipif|xfail)\b/.test(change.content))
      || (change.path.endsWith('.go') && /\.Skip(f|Now)?\s*\(|\/\/\s*(go:build|\+build)/.test(change.content))
      || (change.path.endsWith('.java') && /@(Disabled|Ignore|Enabled\w*|Disabled\w*)\b|\bAssumptions?\s*\./.test(change.content))) throw new Error('Generated tests contain disabled/conditional tests.');
  }
  const policy = policySchema.parse({ rules: ['test', 'it', 'describe'].flatMap(fn => ['skip', 'todo', 'only'].map(modifier => ({
    id: fn + '-' + modifier, kind: 'forbid-call', callee: fn + '.' + modifier, message: 'Generated tests cannot skip, focus or remain TODO.'
  }))) });
  if (checkPolicy(testFiles, policy).length) throw new Error('Generated tests contain disabled/focused tests or invalid syntax.');
  return { summary: answer.summary, scenarios, tests: answer.changes };
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
