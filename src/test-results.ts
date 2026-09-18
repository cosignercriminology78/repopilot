import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { TestCase, TestResult } from './types.js';
import type { ProcessResult } from './process.js';

export function testFile(file: string, root = '/tmp/work'): string {
  const normalized = (file.startsWith('file:') ? fileURLToPath(file) : file).replaceAll('\\', '/');
  const prefix = root.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized.replace(/^\.\//, '');
  if (!relative || posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) {
    throw new Error('Test result file is outside the tested snapshot.');
  }
  return relative;
}
export function testId(file: string, name: string): string { return JSON.stringify([file, name]); }
export function failureFingerprint(failure: string): string {
  // Ignore machine roots and stack positions, retain assertion values and error codes.
  return createHash('sha256').update(failure.replace(/\r\n/g, '\n').split('\n')
    .filter(line => !/^\s*at\s/.test(line)).join('\n').trim()).digest('hex').slice(0, 24);
}
const nodeSchema = z.object({ format: z.literal('repopilot-node-v1'), cases: z.array(z.object({
  file: z.string(), name: z.string().min(1), status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().finite().nonnegative(), failure: z.string().optional()
})), infrastructureErrors: z.array(z.string()) });
const vitestSchema = z.object({
  success: z.boolean(), numTotalTests: z.number().int().nonnegative(),
  testResults: z.array(z.object({ name: z.string(), message: z.string().optional(),
    assertionResults: z.array(z.object({ fullName: z.string().min(1),
      status: z.enum(['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']),
      duration: z.number().nonnegative().nullable().optional(), failureMessages: z.array(z.string()).default([])
    }))
  }))
});
export function parseCases(output: string, adapter: 'node' | 'vitest', root?: string): { cases: TestCase[]; errors: string[] } {
  const raw = JSON.parse(output);
  let rows: { file: string; name: string; status: TestCase['status']; durationMs: number; failure?: string }[];
  const errors: string[] = [];
  if (adapter === 'node') {
    const report = nodeSchema.parse(raw); rows = report.cases; errors.push(...report.infrastructureErrors);
  } else {
    const report = vitestSchema.parse(raw);
    rows = report.testResults.flatMap(suite => {
      if (!suite.assertionResults.length && suite.message) errors.push(suite.message);
      return suite.assertionResults.map(item => ({ file: suite.name, name: item.fullName,
        status: item.status === 'passed' ? 'passed' as const : item.status === 'failed' ? 'failed' as const : 'skipped' as const,
        durationMs: item.duration ?? 0, failure: item.failureMessages.join('\n') || undefined }));
    });
    if (rows.length !== report.numTotalTests) errors.push('Vitest test count mismatch.');
    if (!report.success && !rows.some(row => row.status === 'failed')) errors.push('Vitest reported an infrastructure failure.');
  }
  const ids = new Set<string>();
  const cases = rows.map(row => {
    const file = testFile(row.file, root), id = testId(file, row.name);
    if (ids.has(id)) throw new Error('Ambiguous duplicate test identity: ' + id);
    ids.add(id);
    if (row.status === 'failed' && !row.failure?.trim()) errors.push('Failed test has no failure evidence.');
    return { ...row, file, id, fingerprint: row.status === 'failed' ? failureFingerprint(row.failure ?? '') : undefined };
  });
  return { cases, errors };
}
export function classifyTestResult(result: ProcessResult, adapter: 'node' | 'vitest' | 'command',
  durationMs: number, root?: string): TestResult {
  const common = { exitCode: result.code, output: (result.stdout + result.stderr).slice(-100000), durationMs, cases: [] as TestCase[], structured: false };
  if (result.timedOut || result.code === null || [125, 126, 127, 137].includes(result.code)) {
    return { ...common, status: 'error', reason: result.timedOut ? 'Test execution timed out.' : 'Runner infrastructure failed.' };
  }
  if (adapter === 'command') return { ...common, status: 'not_run', reason: 'Command-only results cannot verify test cases.' };
  try {
    const { cases, errors } = parseCases(result.stdout, adapter, root);
    const structured = { ...common, cases, structured: true };
    if (errors.length) return { ...structured, status: 'error', reason: errors.join('\n') };
    if (!cases.some(c => c.status !== 'skipped')) return { ...structured, status: 'not_run', reason: 'No executed tests (zero or all skipped).' };
    const failed = cases.some(c => c.status === 'failed');
    if ((!failed && result.code !== 0) || (failed && result.code === 0)) return { ...structured, status: 'error', reason: 'Exit code contradicts test report.' };
    return { ...structured, status: failed ? 'failed' : 'passed' };
  } catch (error) { return { ...common, status: 'error', reason: 'Invalid test report: ' + String(error) }; }
}
export function passed(result: TestResult): boolean {
  return result.status === 'passed' && result.structured && result.cases.some(c => c.status === 'passed')
    && result.cases.every(c => c.status !== 'failed');
}
export function sameFailures(a: TestResult, b: TestResult): boolean {
  const failures = (r: TestResult) => r.cases.filter(c => c.status === 'failed').map(c => [c.id, c.fingerprint]).sort((x,y) => String(x[0]).localeCompare(String(y[0])));
  return a.status === 'failed' && b.status === 'failed' && a.structured && b.structured
    && failures(a).length > 0 && JSON.stringify(failures(a)) === JSON.stringify(failures(b));
}
export function preservesTests(before: TestResult, after: TestResult): boolean {
  const byId = new Map(after.cases.map(c => [c.id, c]));
  return before.cases.filter(c => c.status !== 'skipped').every(c => byId.get(c.id)?.status === 'passed');
}
