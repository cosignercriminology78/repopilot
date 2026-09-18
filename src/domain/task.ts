import type { IssueSource, PullRequest, Snapshot } from './types.js';

export interface RunInput { base: Snapshot; head: Snapshot; baseSha: string; headSha: string; pr?: PullRequest; description?: string;
  repoPath?: string; runKey?: string; rerunOf?: string; issue?: IssueSource; }
