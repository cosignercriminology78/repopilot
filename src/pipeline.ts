import type { Config } from './config.js';
import { applyChanges, isTest, semanticFindings, type Agent } from './agent.js';
import { introducedFindings, loadPolicy } from './policy.js';
import { changedPaths } from './git.js';
import { notRun, type Runner } from './runner.js';
import { taskId, type Store } from './store.js';
import type { PullRequest, Report, Snapshot } from './types.js';

export interface RunInput { base: Snapshot; head: Snapshot; baseSha: string; headSha: string; pr?: PullRequest; description?: string; }
export async function runPipeline(input: RunInput, config: Config, store: Store, runner?: Runner, agent?: Agent): Promise<Report> {
  const id = taskId({ repository: config.repository, pr: input.pr?.number, base: input.baseSha, head: input.headSha, config });
  const previous = await store.read(id);
  if (previous && previous.status !== 'running' && previous.status !== 'error') return previous;
  const report: Report = { id, repository: config.repository, pr: input.pr?.number, base: input.baseSha, head: input.headSha,
    status: 'running', findings: [], historical: [], semantic: 'not_run', tests: { base: notRun(), head: notRun() },
    changes: [], attempts: 0, notes: [], createdAt: new Date().toISOString() };
  await store.save(report);
  try {
    const policy = loadPolicy(input.base);
    Object.assign(report, introducedFindings(input.base, input.head, policy));
    if (changedPaths(input.base, input.head).some(path => /(^|\/)AGENTS\.md$/.test(path) || path === '.repopilot/policy.json')) {
      report.notes.push('Policy changes require maintainer review; this run uses policy from the base commit.');
    }
    if (agent) {
      const answer = await agent.review(input.base, input.head, input.description ?? '');
      report.findings.push(...semanticFindings(answer, input.base, input.head));
      report.semantic = 'completed';
    }
    if (runner) {
      report.tests.base = await runner.run(input.base, 'base');
      report.tests.head = await runner.run(input.head, 'head');
    }
    await store.save(report);
    const regression = report.tests.base.status === 'passed' && report.tests.head.status === 'failed';
    const staticErrors = report.findings.filter(f => f.kind === 'static' && f.severity === 'error');
    const semanticErrors = report.findings.some(f => f.kind === 'semantic' && f.severity === 'error');
    const testsHealthy = report.tests.base.status === 'passed' && report.tests.head.status === 'passed';
    if (report.tests.base.status === 'failed') report.notes.push('Base tests already fail; automatic repair is blocked.');
    const policyChanged = report.notes.length > 0;
    if (!report.findings.length && testsHealthy && !policyChanged) report.status = 'passed';
    else report.status = 'needs_attention';
    if (agent && runner && config.agent.repair && !policyChanged && !semanticErrors
      && report.tests.base.status === 'passed' && (report.tests.head.status === 'passed' || regression)
      && (regression || staticErrors.length > 0)) {
      let feedback = '';
      for (let attempt = 1; attempt <= config.agent.maxAttempts; attempt++) {
        report.attempts = attempt;
        const answer = await agent.repair(input.base, input.head, JSON.stringify({
          description: input.description, findings: report.findings, tests: report.tests, previousAttempt: feedback
        }));
        try {
          const candidate = applyChanges(input.head, answer.changes);
          if (!changedPaths(input.head, candidate).length) throw new Error('Repair did not change source.');
          const checks = introducedFindings(input.base, candidate, policy);
          if (checks.findings.some(f => f.severity === 'error')) throw new Error('Repair still violates static policy.');
          if (regression) {
            const newTests = answer.changes.filter(c => !input.head.has(c.path) && isTest(c.path));
            if (!newTests.length) throw new Error('Regression repair requires a new reproducing test.');
            const reproduction = new Map(input.head);
            for (const test of newTests) reproduction.set(test.path, test.content);
            const red = await runner.run(reproduction, `reproduction-${attempt}`);
            if (red.status !== 'failed') throw new Error('Regression test did not fail against original head.');
          }
          report.tests.repaired = await runner.run(candidate, `repair-${attempt}`);
          if (report.tests.repaired.status !== 'passed') throw new Error(`Repair tests did not pass: ${report.tests.repaired.output}`);
          const review = semanticFindings(await agent.review(input.base, candidate, input.description ?? ''), input.base, candidate);
          if (review.some(f => f.severity === 'error')) throw new Error('Repair has unresolved semantic findings.');
          report.changes = answer.changes.filter(c => input.head.get(c.path) !== c.content);
          report.status = 'verified';
          report.notes.push('Repair passed configured tests and policy recheck; original findings retained as evidence.');
          break;
        } catch (error) { feedback = String(error).slice(0, 10000); report.notes.push(`Attempt ${attempt}: ${feedback}`); }
        await store.save(report);
      }
    }
  } catch (error) { report.status = 'error'; report.notes.push(String(error)); }
  await store.save(report);
  return report;
}
