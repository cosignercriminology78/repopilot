import { passed, preservesTests } from './test-evidence.js';
import type { Report, TestPlan, TestResult } from './types.js';

type Assessment = NonNullable<Report['testAssessment']>;
/** Interpret runner evidence; a model label alone never exempts a failing baseline. */
export function assessPlan(plan: TestPlan, originalBase: TestResult, originalHead: TestResult,
  base: TestResult, head: TestResult): Assessment {
  const assessment: Assessment = { eligible: false, reasons: [], cases: [] };
  const block = (reason: string) => assessment.reasons.push(reason);
  const usable = (result: TestResult) => result.structured && ['passed', 'failed'].includes(result.status);
  if (!passed(originalBase) || !usable(originalHead) || !usable(base) || !usable(head)) {
    block('Structured baseline/head evidence is incomplete or contains execution errors.');
    return assessment;
  }
  if (!preservesTests(originalBase, base)) block('Planning changed or removed original baseline tests.');
  const headCases = new Map(head.cases.map(c => [c.id, c]));
  for (const before of originalHead.cases.filter(c => c.status !== 'skipped')) {
    const after = headCases.get(before.id);
    if (!after || before.status !== after.status
      || (before.status === 'failed' && (!before.fingerprint || before.fingerprint !== after.fingerprint))) {
      block('Planning changed an original head test result: ' + before.id);
    }
  }
  const baseCases = new Map(base.cases.map(c => [c.id, c]));
  const generatedFiles = new Set(plan.tests.map(t => t.path));
  for (const file of generatedFiles) {
    const before = base.cases.filter(c => c.file === file);
    const after = head.cases.filter(c => c.file === file);
    if (!before.length || !after.length || before.length !== after.length
      || before.some(c => !after.some(a => a.id === c.id))) {
      block('Generated test identities differ or were not discovered: ' + file);
    }
    const kind = plan.scenarios.find(s => s.testFile === file)?.kind ?? 'regression';
    for (const current of after) {
      const previous = baseCases.get(current.id);
      let outcome: Assessment['cases'][number]['outcome'] = 'unresolved';
      let reason = 'Missing, skipped or ambiguous baseline evidence.';
      if (previous?.status === 'passed' && current.status === 'passed') {
        outcome = 'preserved'; reason = 'The same test passes on base and head.';
      } else if (previous?.status === 'passed' && current.status === 'failed' && current.fingerprint) {
        outcome = 'regression'; reason = 'The same test passes on base and fails on head.';
      } else if (kind === 'new_behavior' && previous?.status === 'failed' && previous.fingerprint && current.status === 'passed') {
        outcome = 'new_behavior_verified'; reason = 'A cited new requirement fails on base and passes on head.';
      } else if (previous?.status === 'failed' && current.status === 'failed') {
        reason = 'Both revisions fail; evidence cannot distinguish an incomplete feature from a bad test.';
      }
      assessment.cases.push({ id: current.id, outcome, reason });
      if (outcome === 'unresolved') block(current.id + ': ' + reason);
    }
  }
  for (const c of base.cases) {
    if (c.status === 'failed' && !generatedFiles.has(c.file)) block('Non-generated baseline test failed: ' + c.id);
  }
  for (const c of head.cases) {
    if (c.status === 'failed' && !generatedFiles.has(c.file) && baseCases.get(c.id)?.status !== 'passed') {
      block('Failing head test has no passing baseline: ' + c.id);
    }
  }
  assessment.eligible = assessment.reasons.length === 0;
  return assessment;
}
