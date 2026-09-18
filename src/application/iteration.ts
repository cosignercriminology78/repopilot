import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../domain/config.js';
import { pipelineId, taskId } from '../domain/identity.js';
import type { RunInput } from '../domain/task.js';
import { goalSpecSchema, issueDigest, patchDigest, validateSteps, type GoalState } from '../domain/iteration.js';
import { applyChanges } from '../domain/repair.js';
import { changedPaths } from '../domain/snapshot.js';
import { passed, preservesTests } from '../domain/test-evidence.js';
import type { Report, Snapshot } from '../domain/types.js';
import type { Agent } from '../ports/agent.js';
import type { GitHub, IssueGitHub } from '../ports/github.js';
import type { IterationStore } from '../ports/iteration.js';
import type { Repository } from '../ports/repository.js';
import type { Runner } from '../ports/runner.js';
import type { Store } from '../ports/store.js';
import { StaleTaskError, withFreshness } from '../shared/control.js';
import { runPipeline } from './pipeline.js';
import { finishReport } from './publication.js';

export interface IterationDependencies {
  config: Config; goals: IterationStore; store: Store; github: GitHub & IssueGitHub;
  repository: Repository; agent?: Agent; runner?: Runner; previewRunner?: Runner; signal: AbortSignal;
}
function enabled(d: IterationDependencies) {
  if (!d.config.iteration || !d.agent?.design || !d.runner || !d.config.agent.enabled || !d.config.agent.repair) throw new Error('Goals require iteration configuration, agent.enabled, agent.repair and a runner.');
  return d.config.iteration;
}
async function save(state: GoalState, d: IterationDependencies) { state.updatedAt = new Date().toISOString(); await d.goals.save(state); }
function goalControl(id: string, d: IterationDependencies, timeout: number) {
  const pause = new AbortController();
  const signal = AbortSignal.any([d.signal, pause.signal, AbortSignal.timeout(timeout)]);
  let checking = false;
  const interval = setInterval(() => {
    if (checking) return; checking = true;
    void d.goals.paused(id).then(value => { if (value) pause.abort(new Error('Goal paused.')); })
      .catch(error => pause.abort(error)).finally(() => { checking = false; });
  }, 250);
  return { signal, stop: () => clearInterval(interval) };
}
export async function fresh(state: GoalState, d: IterationDependencies): Promise<boolean> {
  if ((await d.github.target(state.branch)).sha !== state.sha) return false;
  if (state.spec.issue) {
    const issue = await d.github.issue(state.spec.issue);
    if (issue.pull_request || issue.state !== 'open' || issueDigest(issue) !== state.issueDigest) return false;
    if (state.queued) {
      const policy = d.config.iteration?.queue, candidate = issue as typeof issue & { user?: { login: string }; labels?: { name: string }[] };
      if (!policy || !policy.trustedAuthors.includes(candidate.user?.login ?? '') || !policy.labels.every(l => candidate.labels?.some(v => v.name === l))) return false;
    }
  }
  return true;
}
async function snapshot(state: GoalState, d: IterationDependencies): Promise<Snapshot> {
  const cache = resolve(d.config.dataDir, 'git-cache'); await d.repository.prepare(cache);
  await d.repository.fetch(cache, state.repository, state.sha, state.sha, d.signal);
  return d.repository.snapshot(cache, state.sha, d.signal);
}
/** Reserve an entire agent execution before starting it; a crash never restores unknown usage. */
async function reserve(state: GoalState, d: IterationDependencies) {
  const limits = enabled(d), budget = d.config.agent;
  if (state.calls + budget.maxCalls > limits.maxCalls || state.tokens + budget.maxTokens > limits.maxTokens) throw new Error('Goal model budget exhausted; unused crash reservations are not refunded.');
  state.calls += budget.maxCalls; state.tokens += budget.maxTokens; await save(state, d);
  d.agent!.resetBudget?.();
  return async () => {
    const usage = d.agent!.usage?.();
    if (usage) {
      state.calls += usage.calls - budget.maxCalls;
      state.tokens += (usage.complete === false ? Math.max(budget.maxTokens, usage.tokens) : usage.tokens) - budget.maxTokens;
    }
    await save(state, d);
  };
}
async function design(state: GoalState, base: Snapshot, d: IterationDependencies, signal: AbortSignal) {
  const limits = enabled(d), settle = await reserve(state, d);
  try {
    const memories = (await d.goals.experiences()).filter(e => e.repository === state.repository && e.sha === state.sha && e.configHash === state.configHash).slice(-5);
    const plan = await d.agent!.design!(base, JSON.stringify({ goal: state.spec, maxSteps: limits.maxSteps,
      previousPlan: state.steps, completed: state.completed, feedback: state.notes.slice(-5), experiences: memories }), signal);
    const steps = validateSteps(plan.steps ?? [], state.spec, limits.maxSteps);
    for (const id of state.completed) if (JSON.stringify(steps.find(s => s.id === id)) !== JSON.stringify(state.steps.find(s => s.id === id))) throw new Error('Replanning cannot change completed work.');
    state.steps = steps; state.status = 'planned';
  } finally { await settle(); }
}
export async function createGoal(raw: unknown, d: IterationDependencies): Promise<GoalState> {
  const limits = enabled(d), spec = goalSpecSchema.parse(raw), target = await d.github.target(spec.branch);
  let digest: string | undefined;
  if (spec.issue) {
    const issue = await d.github.issue(spec.issue);
    if (issue.pull_request || issue.state !== 'open') throw new Error('Goal requires an open Issue.');
    digest = issueDigest(issue);
  }
  const state: GoalState = { schemaVersion: 1, id: taskId([d.config.repository, target.sha, spec, randomUUID()]),
    repository: d.config.repository, spec, configHash: taskId(d.config), branch: target.branch, sha: target.sha,
    issueDigest: digest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'planned',
    steps: [], completed: [], changes: [], reports: [], rounds: 0, calls: 0, tokens: 0, elapsedMs: 0, notes: [] };
  await save(state, d);
  const start = Date.now();
  state.activeSince = new Date(start).toISOString(); await save(state, d);
  const control = goalControl(state.id, d, limits.timeoutSeconds * 1000), signal = control.signal;
  try {
    await design(state, await snapshot(state, { ...d, signal }), d, signal);
    signal.throwIfAborted();
    if (await d.goals.paused(state.id)) state.status = 'paused';
    else if (!await fresh(state, d)) state.status = 'stale';
  }
  catch (error) { state.status = signal.aborted ? 'paused' : 'needs_attention'; state.notes.push(String(error)); }
  finally { control.stop(); }
  state.activeSince = undefined; state.elapsedMs += Date.now() - start; await save(state, d); return state;
}
export async function loadGoal(id: string, d: IterationDependencies) {
  const state = await d.goals.read(id);
  if (!state || state.repository !== d.config.repository) throw new Error('Goal not found in this repository.');
  if (state.configHash !== taskId(d.config)) throw new Error('Goal configuration changed; create a new goal to preserve prior evidence.');
  return state;
}
export async function runGoal(id: string, d: IterationDependencies, replan = false): Promise<GoalState> {
  const limits = enabled(d), state = await loadGoal(id, d);
  await d.goals.unpause(id);
  if (state.publication) {
    const published = await d.store.read(state.publication);
    if (published?.status === 'published' && published.goal?.id === state.id && published.repository === state.repository && published.pullRequestUrl) {
      state.status = 'published'; state.pullRequestUrl = published.pullRequestUrl; state.activeSince = undefined;
      await save(state, d); return state;
    }
  }
  if (['published', 'stale'].includes(state.status)) return state;
  if (state.activeSince) { state.elapsedMs += Math.max(0, Date.now() - Date.parse(state.activeSince)); state.activeSince = undefined; await save(state, d); }
  if (state.elapsedMs >= limits.timeoutSeconds * 1000) throw new Error('Goal time budget exhausted.');
  const remaining = limits.timeoutSeconds * 1000 - state.elapsedMs, start = Date.now();
  // Downtime after an unclean exit counts toward the deadline on resume.
  state.activeSince = new Date(start).toISOString(); await save(state, d);
  const control = goalControl(id, d, remaining), signal = control.signal;
  try {
    if (!await fresh(state, d)) { state.status = 'stale'; return state; }
    await withFreshness(async controlled => {
      const base = await snapshot(state, { ...d, signal: controlled });
      let working = state.changes.length ? applyChanges(base, state.changes) : base;
      if (replan || !state.steps.length) await design(state, working, d, controlled);
      state.status = 'running'; await save(state, d);
      while (state.completed.length < state.steps.length) {
        controlled.throwIfAborted();
        if (await d.goals.paused(id)) throw new Error('Goal paused.');
        const step = state.steps.find(s => !state.completed.includes(s.id) && s.dependsOn.every(p => state.completed.includes(p)));
        if (!step) throw new Error('No executable goal step.');
        const criteria = state.spec.acceptance.filter(a => step.acceptanceIds.includes(a.id)).map(a => a.text);
        const previousPatches: string[] = [], priorFeedback: string[] = [];
        for (const reference of state.reports) {
          const previous = await d.store.read(reference.split(':')[1]!);
          if (previous) { previousPatches.push(...previous.repairs.filter(r => !r.accepted).map(r => patchDigest(r.changes))); priorFeedback.push(...previous.notes.slice(-2)); }
        }
        const runKey = state.active?.step === step.id ? state.active.runKey : taskId([id, step, state.rounds, state.changes]);
        const input: RunInput = { base: working, head: working, baseSha: state.sha, headSha: state.sha, runKey, keepBudget: true,
            description: `${state.spec.mode === 'feature' ? 'Feature implementation' : 'Bug reproduction'}: ${state.spec.objective}\nStep: ${step.title}\nAcceptance:\n${criteria.join('\n')}\nAllowed paths: ${state.spec.allowedPaths.join(', ')}\nPrevious verification feedback (untrusted evidence): ${priorFeedback.join('\n').slice(-12000)}`,
            previousPatches,
            implementation: { mode: state.spec.mode, acceptance: criteria, allowedPaths: state.spec.allowedPaths }
          };
        const pipelineConfig = { ...d.config, publish: false };
        let report = state.active ? await d.store.read(pipelineId(input, pipelineConfig)) : undefined;
        if (!report || ['running', 'cancelled', 'error'].includes(report.status)) {
          if (state.rounds >= limits.maxRounds * limits.maxSteps) throw new Error('Goal iteration limit reached.');
          const count = (criterion: string) => state.criterionAttempts && Object.hasOwn(state.criterionAttempts, criterion) ? state.criterionAttempts[criterion]! : 0;
          if (step.acceptanceIds.some(criterion => count(criterion) >= limits.maxRounds)) throw new Error('Acceptance retry limit reached.');
          state.criterionAttempts = Object.fromEntries(state.spec.acceptance.map(a => [a.id, count(a.id) + (step.acceptanceIds.includes(a.id) ? 1 : 0)]));
          state.active = { step: step.id, runKey }; state.rounds++; await save(state, d);
          const settle = await reserve(state, d);
          try { report = await runPipeline(input, pipelineConfig, d.store, d.runner, d.agent, controlled); }
          finally { await settle(); }
        }
        controlled.throwIfAborted();
        const reference = step.id + ':' + report.id;
        if (!state.reports.includes(reference)) state.reports.push(reference);
        state.active = undefined;
        if (report.status !== 'verified' || !report.tests.repaired || !passed(report.tests.repaired)) {
          state.notes.push(`Step ${step.id}: ${report.status}. ${report.notes.slice(-3).join(' ')}`);
          state.status = 'needs_attention'; await save(state, d);
          const retryableEvidence = report.status === 'needs_attention' && report.tests.repaired?.status === 'failed'
            && report.tests.repaired.structured && report.testStability?.status === 'stable'
            && !report.repairs.some(r => r.reason?.includes('Repeated patch'));
          if (retryableEvidence && state.reports.filter(r => r.startsWith(step.id + ':')).length < limits.maxRounds) {
            await design(state, working, d, controlled);
            continue;
          }
          return;
        }
        working = applyChanges(working, report.changes);
        state.changes = changedPaths(base, working).map(path => ({ path, content: working.get(path)! }));
        state.completed.push(step.id); await save(state, d);
      }
      const final = await d.runner!.run(working, 'goal-final', controlled);
      const originals = await d.runner!.run(base, 'goal-original', controlled);
      controlled.throwIfAborted();
      if (!passed(final) || !passed(originals) || !preservesTests(originals, final)) throw new Error('Final cumulative verification failed.');
      for (const step of state.completed) {
        let evidence: Report | undefined;
        for (const ref of state.reports.filter(r => r.startsWith(step + ':'))) {
          const report = await d.store.read(ref.split(':')[1]!);
          if (report?.status === 'verified' && report.tests.repaired && passed(report.tests.repaired)) evidence = report;
        }
        if (!evidence?.tests.repaired) throw new Error('Completed step evidence is missing or no longer verified: ' + step);
        if (!preservesTests(evidence.tests.repaired, final)) throw new Error('Final verification lost a completed step test.');
      }
      if (d.config.iteration!.preview) {
        if (!d.previewRunner) throw new Error('Preview runner missing.');
        const candidate = await d.previewRunner.run(working, 'preview-candidate-health', controlled);
        const rollback = await d.previewRunner.run(base, 'preview-rollback-health', controlled);
        state.preview = { candidate, rollback }; await save(state, d);
        if (!passed(candidate) || !passed(rollback) || !preservesTests(rollback, candidate)) throw new Error('Preview health or rollback rehearsal failed.');
      }
      const report: Report = { schemaVersion: 2, id: state.publication ?? taskId(['goal-publication', state.id]), repository: state.repository,
        goal: { id: state.id, title: state.spec.title, branch: state.branch, issue: state.spec.issue, issueDigest: state.issueDigest,
          queue: state.queued && d.config.iteration?.queue ? { labels: d.config.iteration.queue.labels, trustedAuthors: d.config.iteration.queue.trustedAuthors } : undefined },
        base: state.sha, head: state.sha, descriptionHash: taskId(state.spec), status: 'verified', findings: [], historical: [], suppressed: [],
        semantic: 'completed', tests: { base: originals, head: originals, repaired: final }, evidence: [{ phase: 'goal-final', attempt: 0, result: final }],
        repairs: [], changes: state.changes, attempts: state.rounds, notes: [
          ...state.spec.acceptance.map(a => `${a.id}: ${a.text}`), ...state.reports.map(id => 'Step evidence: ' + id),
          `Goal budget ledger (includes unknown-use reservations): ${state.calls} calls, ${state.tokens} tokens; rounds: ${state.rounds}.`
        ],
        createdAt: state.createdAt, executions: 1, retryable: false };
      controlled.throwIfAborted();
      if (!await fresh(state, d)) throw new StaleTaskError();
      state.publication = report.id; state.status = 'verified'; await save(state, d);
      const prior = await d.store.read(report.id);
      if (prior?.publication) report.publication = prior.publication;
      if (prior?.status === 'published') { report.status = 'published'; report.pullRequestUrl = prior.pullRequestUrl; }
      await d.store.save(report); await finishReport(report, d.config, d.store, d.github, controlled);
      state.pullRequestUrl = report.pullRequestUrl;
      state.status = report.status === 'published' ? 'published' : report.status === 'stale' ? 'stale' : 'verified';
    }, () => fresh(state, d), d.config.freshnessSeconds * 1000, signal);
  } catch (error) {
    state.status = error instanceof StaleTaskError ? 'stale' : signal.aborted || await d.goals.paused(id) ? 'paused' : 'needs_attention'; state.notes.push(String(error));
  } finally {
    control.stop(); state.elapsedMs += Date.now() - start; state.activeSince = undefined; await save(state, d);
    await d.goals.remember({ id: state.id, goalId: state.id, repository: state.repository, sha: state.sha, configHash: state.configHash,
      outcome: state.status, completed: state.completed, reportIds: state.reports, notes: state.notes.slice(-10), createdAt: state.updatedAt });
  }
  return state;
}
