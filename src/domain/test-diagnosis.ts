import { sameFailures } from './test-evidence.js';
import type { Report, TestResult } from './types.js';

export function diagnose(result: TestResult): TestResult {
  if (result.failure || result.status === 'passed') return result;
  const kind = result.status === 'failed' && result.structured ? 'test_failure'
    : result.status === 'not_run' ? 'test_discovery' : 'invalid_report';
  return { ...result, failure: { kind, retryable: false } };
}

export function assessStability(first: TestResult, repeat: TestResult): NonNullable<Report['testStability']> {
  if (!first.structured || first.status !== 'failed' || !repeat.structured || !['failed', 'passed'].includes(repeat.status)
    || [first, repeat].some(result => new Set(result.cases.map(c => c.id)).size !== result.cases.length
      || result.cases.some(c => c.status === 'failed' && !c.fingerprint))) {
    return { status: 'inconclusive', reason: 'Repetition lacks usable test evidence; repair blocked.' };
  }
  const identities = (result: TestResult) => result.cases.map(c => [c.id, c.status === 'skipped']).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (JSON.stringify(identities(first)) !== JSON.stringify(identities(repeat))) {
    return { status: 'inconclusive', reason: 'Test discovery changed on repetition; repair blocked.' };
  }
  return sameFailures(first, repeat)
    ? { status: 'stable', reason: 'The same test identities and failure fingerprints repeated.' }
    : { status: 'unstable', reason: 'Failure identities or fingerprints changed on repetition; repair blocked.' };
}
