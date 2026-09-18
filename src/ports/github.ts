import type { PullRequest, Report } from '../domain/types.js';
export interface GitHub {
  listPulls(): Promise<PullRequest[]>;
  pull(number: number): Promise<PullRequest>;
  current(report: Report): Promise<PullRequest | undefined>;
  publish(report: Report, signal?: AbortSignal): Promise<string | undefined>;
}
