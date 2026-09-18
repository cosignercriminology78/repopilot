import type { Issue, PullRequest, Report } from '../domain/types.js';
export interface IssueGitHub {
  issue(number: number): Promise<Issue>;
  target(branch?: string): Promise<{ branch: string; sha: string }>;
}
export interface GitHub {
  listPulls(): Promise<PullRequest[]>;
  pull(number: number): Promise<PullRequest>;
  current(report: Report): Promise<PullRequest | Issue | undefined>;
  publish(report: Report, signal?: AbortSignal): Promise<string | undefined>;
}
