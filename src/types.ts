export type FileMode = '100644' | '100755';
export type Snapshot = Map<string, string> & { modes?: Map<string, FileMode> };
export interface Finding {
  ruleId: string; path: string; line: number; message: string;
  source: string; severity: 'error' | 'warning'; kind: 'static' | 'semantic';
  ruleQuote?: string; evidence?: string;
}
export interface TestCase {
  id: string; file: string; name: string;
  status: 'passed' | 'failed' | 'skipped'; durationMs: number;
  failure?: string; fingerprint?: string;
}
export interface TestResult {
  status: 'passed' | 'failed' | 'error' | 'not_run';
  exitCode: number | null; output: string; durationMs: number;
  cases: TestCase[]; structured: boolean; reason?: string;
}
export interface PullRequest {
  number: number; title: string; body: string; state: string; draft: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
}
export interface RepairChange { path: string; content: string; }
export interface TestPlan {
  summary: string;
  scenarios: { name: string; requirement: string; testFile: string; kind: 'regression' | 'new_behavior'; requirementQuote?: string }[];
  tests: RepairChange[];
}
export interface TestEvidence { phase: string; attempt: number; result: TestResult; }
export interface RepairAttempt { number: number; changes: RepairChange[]; summary: string; accepted: boolean; reason?: string; }
export interface Report {
  schemaVersion: 2; id: string; repository: string; pr?: number; base: string; head: string;
  descriptionHash: string;
  status: 'running' | 'passed' | 'needs_attention' | 'verified' | 'published' | 'stale' | 'cancelled' | 'error';
  findings: Finding[]; historical: Finding[]; suppressed: { finding: Finding; reason: string; expiresAt: string }[];
  semantic: 'not_run' | 'completed';
  tests: { base: TestResult; head: TestResult; repaired?: TestResult };
  plan?: TestPlan; evidence: TestEvidence[]; repairs: RepairAttempt[];
  testAssessment?: { eligible: boolean; reasons: string[]; cases: { id: string; outcome: 'regression' | 'new_behavior_verified' | 'preserved' | 'unresolved'; reason: string }[] };
  changes: RepairChange[]; attempts: number; notes: string[]; createdAt: string;
  executions: number; retryAfter?: string; retryable: boolean;
  agentUsage?: { calls: number; tokens: number };
  pullRequestUrl?: string;
  publication?: { attempts: number; retryAfter?: string; error?: string; retryable: boolean };
  replay?: { repoPath: string; description: string; pr?: PullRequest; runKey?: string };
  rerunOf?: string;
}
