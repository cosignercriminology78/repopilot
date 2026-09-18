import type { Config } from '../domain/config.js';
import { descriptionHash, pipelineId } from '../domain/identity.js';
import { applyExceptions, introducedFindings, loadPolicy, partitionFindings } from '../domain/policy.js';
import { applyChanges, isTest, semanticFindings, validatePlan } from '../domain/repair.js';
import { reproduced } from '../domain/reproduction.js';
import { changedPaths } from '../domain/snapshot.js';
import type { RunInput } from '../domain/task.js';
import { assessPlan } from '../domain/test-assessment.js';
import { notRun, passed, preservesTests } from '../domain/test-evidence.js';
import { assessStability, diagnose } from '../domain/test-diagnosis.js';
import type { Report, Snapshot, TestResult } from '../domain/types.js';
import { type Agent } from '../ports/agent.js';
import { type Runner } from '../ports/runner.js';
import { type Store } from '../ports/store.js';
import { pause, RetryableError, StaleTaskError, throwIfAborted } from '../shared/control.js';
import { TaskCancelledError, withTaskCancellation } from './task-control.js';

export async function runPipeline(input: RunInput, config: Config, store: Store, runner?: Runner, agent?: Agent, parent?: AbortSignal): Promise<Report> {
  return withTaskCancellation(store, pipelineId(input, config), signal => executePipeline(input, config, store, runner, agent, signal), parent);
}
async function executePipeline(input: RunInput, config: Config, store: Store, runner?: Runner, agent?: Agent, parent?: AbortSignal): Promise<Report> {
  const description = input.pr ? `${input.pr.title}\n${input.pr.body ?? ''}` : input.description ?? '';
  const hash = descriptionHash(input.pr, description);
  const id = pipelineId(input, config);
  const previous = await store.read(id);
  if (previous && input.repoPath && !previous.replay) {
    previous.replay = { repoPath: input.repoPath, description, pr: input.pr, issue: input.issue, runKey: input.runKey };
    await store.save(previous);
  }
  if (previous && parent?.reason instanceof TaskCancelledError) {
    if (previous.status !== 'published') { previous.status = 'cancelled'; await store.save(previous); }
    return previous;
  }
  if (previous && ['running', 'cancelled'].includes(previous.status) && previous.executions >= config.retry.maxTaskExecutions) {
    previous.status = 'error'; previous.retryable = false;
    previous.notes.push('Task execution limit reached after interruption.'); await store.save(previous); return previous;
  }
  if (previous && previous.status !== 'running' && previous.status !== 'cancelled'
    && !(previous.status === 'error' && previous.retryable && previous.executions < config.retry.maxTaskExecutions
      && Date.parse(previous.retryAfter ?? '') <= Date.now())) return previous;
  if (previous) await store.archive(previous);
  const report: Report = { schemaVersion: 2, id, repository: config.repository, pr: input.pr?.number, base: input.baseSha, head: input.headSha,
    descriptionHash: hash, status: 'running', findings: [], historical: [], suppressed: [], semantic: 'not_run',
    tests: { base: notRun(), head: notRun() }, evidence: [], repairs: [], changes: [], attempts: 0, notes: [],
    createdAt: new Date().toISOString(), executions: (previous?.executions ?? 0) + 1, retryable: false,
    issue: input.issue,
    replay: input.repoPath ? { repoPath: input.repoPath, description, pr: input.pr, issue: input.issue, runKey: input.runKey } : undefined,
    rerunOf: input.rerunOf };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Task time budget exceeded.')), config.taskTimeoutSeconds * 1000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  agent?.resetBudget?.();
  const save = async () => { report.agentUsage = agent?.usage?.(); await store.save(report); };
  const run = async (files: Snapshot, phase: string, attempt = 0): Promise<TestResult> => {
    throwIfAborted(signal);
    const limit = config.runner?.environmentAttempts ?? 2;
    for (let execution = 1; ; execution++) {
      const result = diagnose(await runner!.run(files, phase, signal));
      throwIfAborted(signal);
      report.evidence.push({ phase, attempt, execution, result }); await save();
      if (result.status !== 'error' || result.failure?.kind !== 'environment' || !result.failure.retryable || execution >= limit) return result;
      await pause(Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (execution - 1)), signal);
    }
  };
  try {
    await save(); throwIfAborted(signal);
    if (input.issue && (input.pr || input.baseSha !== input.headSha || changedPaths(input.base, input.head).length)) throw new Error('Issue reproduction requires one pinned target snapshot.');
    if (input.issue && (!agent || !runner || !config.agent.repair)) throw new Error('Issue reproduction requires an agent, runner and enabled repairs.');
    const policy = loadPolicy(input.base), paths = input.issue ? [...input.head.keys()] : changedPaths(input.base, input.head);
    Object.assign(report, introducedFindings(input.base, input.head, policy));
    const policyChanged = changedPaths(input.base, input.head).some(path => /(^|\/)AGENTS\.md$/.test(path) || path === '.repopilot/policy.json');
    if (policyChanged) report.notes.push('Policy changes require maintainer review; using base policy.');
    let baselineSemantic: ReturnType<typeof semanticFindings> = [];
    if (agent) {
      baselineSemantic = semanticFindings(await agent.review(input.base, input.base, description, signal, paths), input.base, input.base, paths);
      const current = semanticFindings(await agent.review(input.base, input.head, description, signal, paths), input.base, input.head, paths);
      const semantic = partitionFindings(baselineSemantic, current, input.base, input.head);
      report.findings.push(...semantic.findings); report.historical.push(...semantic.historical); report.semantic = 'completed';
    }
    Object.assign(report, applyExceptions(report.findings, policy));
    if (runner) { report.tests.base = await run(input.base, 'base'); report.tests.head = await run(input.head, 'head'); }
    let working = input.head, red = report.tests.head, baseline = report.tests.base;
    const issueBaseline = !input.issue || (passed(red) && preservesTests(baseline, red) && preservesTests(red, baseline));
    let eligible = passed(baseline) && issueBaseline;
    if (agent && runner && !policyChanged && issueBaseline && passed(baseline) && ['passed', 'failed'].includes(red.status)) {
      report.plan = validatePlan(await agent.plan(input.base, input.head, description, signal), input.head, description);
      if (input.issue && report.plan.scenarios.some(s => s.kind !== 'regression' || !s.requirementQuote || s.requirementQuote.trim().length < 8
        || !description.includes(s.requirementQuote))) throw new Error('Issue reproduction requires regression scenarios with exact Issue requirement quotes.');
      working = applyChanges(input.head, report.plan.tests);
      baseline = await run(applyChanges(input.base, report.plan.tests), 'planned-base');
      red = await run(working, 'planned-head');
      for (const test of report.plan.tests) {
        const cases = red.cases.filter(c => c.file === test.path);
        if (!cases.length || cases.some(c => c.status === 'skipped')) throw new Error('Generated tests were not fully executed: ' + test.path);
      }
      if (input.issue) {
        eligible = reproduced(report.plan, report.tests.base, baseline, red);
        report.notes.push(eligible ? 'Issue reproduced by stable generated test failures on the pinned target.' : 'Issue was not reproducibly demonstrated; repair blocked.');
      } else {
        report.testAssessment = assessPlan(report.plan, report.tests.base, report.tests.head, baseline, red);
        eligible = report.testAssessment.eligible;
        report.notes.push(...report.testAssessment.reasons);
      }
    }
    const regression = eligible && red.status === 'failed' && red.structured;
    if (!passed(report.tests.base)) report.notes.push('Base tests already fail or lack structured passing evidence; automatic repair is blocked.');
    if (!eligible) report.notes.push('Test evidence requires maintainer review.');
    const preservedBase = preservesTests(report.tests.base, report.tests.head);
    if (passed(report.tests.head) && !preservedBase) report.notes.push('Head removed or skipped baseline tests; maintainer review required.');
    report.status = !report.findings.length && passed(red) && eligible && preservedBase && !policyChanged ? 'passed' : 'needs_attention';
    if (agent && runner && config.agent.repair && !policyChanged && eligible
      && (regression || (passed(red) && report.findings.some(f => f.severity === 'error')))) {
      if (regression) report.testStability = assessStability(red, await run(working, 'repeat-head'));
      if (regression && report.testStability?.status !== 'stable') {
        report.notes.push(report.testStability!.reason);
      } else {
        let feedback = '';
        for (let attempt = 1; attempt <= config.agent.maxAttempts; attempt++) {
          throwIfAborted(signal); report.attempts = attempt;
          const answer = await agent.repair(input.base, working, JSON.stringify({ description,
            findings: report.findings, failedTests: red, plan: report.plan, previousAttempt: feedback }), signal);
          const record = { number: attempt, changes: answer.changes, summary: answer.summary, accepted: false, reason: '' };
          report.repairs.push(record);
          try {
            if (answer.changes.some(c => isTest(c.path))) throw new Error('Repair must preserve frozen tests.');
            const candidate = applyChanges(working, answer.changes);
            if (!changedPaths(working, candidate).length) throw new Error('Repair did not change source.');
            const checks = applyExceptions(introducedFindings(input.base, candidate, policy).findings, policy);
            if (checks.findings.some(f => f.severity === 'error')) throw new Error('Repair still violates static policy.');
            report.tests.repaired = await run(candidate, 'repair', attempt);
            if (report.tests.repaired.status === 'error' || report.tests.repaired.status === 'not_run') {
              record.reason = 'Repair verification is inconclusive; no further source changes requested.';
              report.notes.push(record.reason); break;
            }
            if (!passed(report.tests.repaired) || !preservesTests(red, report.tests.repaired)
              || !preservesTests(report.tests.head, report.tests.repaired)
              || !preservesTests(report.tests.base, report.tests.repaired)) throw new Error('Repair did not pass the same test identities.');
            const reviewed = semanticFindings(await agent.review(input.base, candidate, description, signal),
              input.base, candidate);
            const semantic = partitionFindings(baselineSemantic, reviewed, input.base, candidate);
            if (applyExceptions(semantic.findings, policy).findings.some(f => f.severity === 'error')) throw new Error('Repair has unresolved semantic findings.');
            report.changes = changedPaths(input.head, candidate).map(path => ({ path, content: candidate.get(path)! }));
            report.status = 'verified'; record.accepted = true; break;
          } catch (error) {
            throwIfAborted(signal);
            if (error instanceof RetryableError) throw error;
            feedback = String(error).slice(0, 10000); record.reason = feedback;
            report.notes.push('Attempt ' + attempt + ': ' + feedback);
          }
          await save();
        }
      }
    }
    throwIfAborted(signal);
  } catch (error) {
    report.status = signal.reason instanceof StaleTaskError ? 'stale' : parent?.aborted ? 'cancelled' : 'error';
    report.retryable = error instanceof RetryableError;
    if (error instanceof RetryableError) report.retryAfter = new Date(Date.now() + Math.max(error.retryAfterMs,
      Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** (report.executions - 1)))).toISOString();
    report.notes.push(String(error));
  } finally { clearTimeout(timer); }
  await save(); return report;
}
