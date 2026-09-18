import type { Issue, PullRequest, Report } from '../domain/types.js';
export interface QueueIssue extends Issue { user: { login: string }; labels: { name: string }[]; created_at: string; }
export interface PullFeedback {
  pr: PullRequest;
  headRun?: string;
  checks: { name: string; status: string; conclusion: string | null }[];
  comments: { id: string; author: string; body: string; commit?: string }[];
}
export interface AutomationGitHub {
  issues(state: 'open' | 'all'): Promise<QueueIssue[]>;
  feedback(number: number): Promise<PullFeedback>;
  updatePull(report: Report, number: number, expectedHead: string, expectedBase: string, feedbackDigest: string, signal?: AbortSignal): Promise<{ url: string; head: string } | undefined>;
  recoverPull(report: Report, number: number, branch: string): Promise<{ url: string; head: string } | undefined>;
  propose(title: string, body: string): Promise<string>;
}
