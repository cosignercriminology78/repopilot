import { taskId } from '../domain/identity.js';
import type { GoalState } from '../domain/iteration.js';

export interface EvaluationRecord {
  goalId: string;
  suite: string;
  case: string;
  profile: string;
  caseDigest: string;
  outcome: 'healthy' | 'regressed' | 'published' | 'verified' | 'failed';
  completed: number;
  steps: number;
  rounds: number;
  calls: number;
  tokens: number;
  elapsedMs: number;
}

const ratio = (value: number, total: number) => total ? Number((value / total).toFixed(4)) : 0;
const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

function outcome(goal: GoalState): EvaluationRecord['outcome'] {
  if (goal.postMerge?.status === 'healthy') return 'healthy';
  if (['regressed', 'closed_unmerged'].includes(goal.postMerge?.status ?? '')) return 'regressed';
  if (goal.status === 'published') return 'published';
  if (goal.status === 'verified') return 'verified';
  return 'failed';
}

export function evaluateGoals(goals: GoalState[], suite?: string) {
  const records: EvaluationRecord[] = goals.filter(goal => goal.spec.evaluation && (!suite || goal.spec.evaluation.suite === suite))
    .map(goal => {
      const { evaluation: _evaluation, ...spec } = goal.spec;
      return { goalId: goal.id, ...goal.spec.evaluation!, caseDigest: taskId([goal.repository, goal.sha, spec]),
        outcome: outcome(goal), completed: goal.completed.length, steps: goal.steps.length, rounds: goal.rounds,
        calls: goal.calls, tokens: goal.tokens, elapsedMs: goal.elapsedMs };
    })
    .sort((a, b) => a.suite.localeCompare(b.suite) || a.profile.localeCompare(b.profile)
      || a.case.localeCompare(b.case) || a.goalId.localeCompare(b.goalId));
  const duplicateKeys = [...new Set(records.map(record => `${record.suite}/${record.profile}/${record.case}`)
    .filter((key, index, all) => all.indexOf(key) !== index))];
  const inconsistentCases = [...new Set(records.map(record => `${record.suite}/${record.case}`))].filter(key => {
    const digests = records.filter(record => `${record.suite}/${record.case}` === key).map(record => record.caseDigest);
    return new Set(digests).size > 1;
  });
  const profiles = [...new Set(records.map(record => record.profile))].sort().map(profile => {
    const items = records.filter(record => record.profile === profile), terminal = items.filter(item => item.outcome !== 'failed');
    const verified = items.filter(item => ['verified', 'published', 'healthy'].includes(item.outcome));
    const published = items.filter(item => ['published', 'healthy'].includes(item.outcome));
    const observed = items.filter(item => ['healthy', 'regressed'].includes(item.outcome));
    return { profile, cases: items.length, completionRate: ratio(terminal.length, items.length),
      verificationRate: ratio(verified.length, items.length), publicationRate: ratio(published.length, items.length),
      postMergePassRate: ratio(items.filter(item => item.outcome === 'healthy').length, observed.length),
      regressions: items.filter(item => item.outcome === 'regressed').length,
      averageRounds: average(items.map(item => item.rounds)), averageCalls: average(items.map(item => item.calls)),
      averageTokens: average(items.map(item => item.tokens)), averageElapsedMs: average(items.map(item => item.elapsedMs)) };
  });
  const results = records.map(({ goalId: _goalId, ...record }) => record);
  return { schemaVersion: 1, suite: suite ?? null, digest: taskId(results), evidenceDigest: taskId(records),
    duplicateKeys, inconsistentCases, profiles, records };
}
