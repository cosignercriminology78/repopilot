import { createHash } from 'node:crypto';
import type { TestResult } from './types.js';

export function testId(file: string, name: string): string { return JSON.stringify([file, name]); }
export function failureFingerprint(failure: string): string {
  // Ignore machine roots and stack positions, retain assertion values and error codes.
  return createHash('sha256').update(failure.replace(/\r\n/g, '\n').split('\n')
    .filter(line => !/^\s*at\s/.test(line)).join('\n').trim()).digest('hex').slice(0, 24);
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
export const notRun = (): TestResult => ({ status: 'not_run', exitCode: null, output: 'No test runner configured.',
  durationMs: 0, cases: [], structured: false });
