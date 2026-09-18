export type Snapshot = Map<string, string>;
export interface Finding {
  ruleId: string; path: string; line: number; message: string;
  source: string; severity: 'error' | 'warning'; kind: 'static' | 'semantic';
}
export interface TestResult {
  status: 'passed' | 'failed' | 'error' | 'not_run';
  exitCode: number | null; output: string; durationMs: number;
}
export interface PullRequest {
  number: number; title: string; body: string; state: string; draft: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
}
export interface RepairChange { path: string; content: string; }
export interface Report {
  id: string; repository: string; pr?: number; base: string; head: string;
  status: 'running' | 'passed' | 'needs_attention' | 'verified' | 'published' | 'stale' | 'error';
  findings: Finding[]; historical: Finding[]; semantic: 'not_run' | 'completed';
  tests: { base: TestResult; head: TestResult; repaired?: TestResult };
  changes: RepairChange[]; attempts: number; notes: string[]; createdAt: string;
  pullRequestUrl?: string;
}
