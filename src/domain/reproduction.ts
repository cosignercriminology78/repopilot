import { passed, preservesTests, sameFailures } from './test-evidence.js';
import type { TestPlan, TestResult } from './types.js';

export function reproduced(plan: TestPlan, original: TestResult, first: TestResult, second: TestResult): boolean {
  const generated = new Set(plan.tests.map(t => t.path));
  return passed(original) && sameFailures(first, second) && preservesTests(original, first) && preservesTests(original, second)
    && first.cases.length === second.cases.length
    && first.cases.every(c => second.cases.some(other => other.id === c.id && other.status === c.status))
    && plan.tests.every(t => first.cases.some(c => c.file === t.path) && !first.cases.some(c => c.file === t.path && c.status === 'skipped'))
    && first.cases.some(c => c.status === 'failed' && generated.has(c.file))
    && first.cases.filter(c => c.status === 'failed').every(c => generated.has(c.file));
}
