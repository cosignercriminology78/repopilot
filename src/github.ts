import type { PullRequest, Report } from './types.js';
import { descriptionHash } from './pipeline.js';
import { passed } from './test-results.js';
import { markdownReport } from './report.js';
import { RetryableError, retry, type RetryOptions } from './control.js';

export class GitHub {
  constructor(readonly repository: string, private token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    private options: { signal?: AbortSignal; transport?: typeof fetch; retry?: RetryOptions } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository.');
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const operation = async () => {
      const timeout = AbortSignal.timeout(30000);
      const response = await (this.options.transport ?? fetch)(`https://api.github.com/repos/${this.repository}/${path}`, {
        method, signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout, redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RepoPilot/0.1',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      }).catch(error => {
        this.options.signal?.throwIfAborted();
        if (error instanceof TypeError || timeout.aborted) throw new RetryableError('GitHub transport unavailable or timed out.');
        throw error;
      });
      if (!response.ok) {
        const message = `GitHub ${method} ${path}: HTTP ${response.status}`;
        if (response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
          const header = response.headers.get('retry-after') ?? '0';
          const seconds = Number(header);
          const retryDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
          throw new RetryableError(message, Math.max(0, Number.isFinite(retryDelay) ? retryDelay : 0, Number.isFinite(reset) ? reset : 0));
        }
        throw new Error(message);
      }
      return await response.json() as T;
    };
    return method === 'GET' ? retry(operation, this.options.retry ?? { attempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 }, this.options.signal) : operation();
  }
  async listPulls(): Promise<PullRequest[]> {
    const pulls: PullRequest[] = [];
    for (let page = 1; page <= 10; page++) {
      const items = await this.request<PullRequest[]>(`pulls?state=open&per_page=100&page=${page}`);
      pulls.push(...items); if (items.length < 100) return pulls;
    }
    throw new Error('Over 1,000 open PRs; narrow the MVP repository.');
  }
  pull(number: number): Promise<PullRequest> { return this.request(`pulls/${number}`); }
  async current(report: Report): Promise<PullRequest | undefined> {
    if (!report.pr) return undefined;
    const pr = await this.pull(report.pr);
    return pr.state === 'open' && !pr.draft && !pr.head.ref.startsWith('autofix/') && pr.head.repo?.full_name === this.repository
      && pr.head.sha === report.head && pr.base.sha === report.base && descriptionHash(pr) === report.descriptionHash ? pr : undefined;
  }
  async publish(report: Report): Promise<string | undefined> {
    if (!this.token) throw new Error('GITHUB_TOKEN is required to publish.');
    if (report.repository !== this.repository || report.status !== 'verified' || !report.changes.length
      || !report.tests.repaired || !passed(report.tests.repaired)) throw new Error('Only verified repairs can be published.');
    const pr = await this.current(report);
    if (!pr) return undefined;
    const branch = `autofix/pr-${report.pr}/${report.id}`;
    const existing = await this.request<{ html_url: string; state: string; head: { sha: string } }[]>(`pulls?state=all&head=${encodeURIComponent(this.repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(pr.head.ref)}`);
    // Git data objects can be retried without moving a ref or touching the source PR branch.
    const parent = await this.request<{ tree: { sha: string } }>(`git/commits/${report.head}`);
    const sourceTree = await this.request<{ truncated: boolean; tree: { path: string; mode: string; type: string }[] }>(`git/trees/${parent.tree.sha}?recursive=1`);
    if (sourceTree.truncated) throw new Error('Source tree is truncated; cannot preserve file modes.');
    const modes = new Map(sourceTree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.mode]));
    for (const change of report.changes) if (modes.has(change.path) && !['100644', '100755'].includes(modes.get(change.path)!)) throw new Error('Unsupported file mode.');
    const tree = await this.request<{ sha: string }>('git/trees', 'POST', {
      base_tree: parent.tree.sha,
      tree: report.changes.map(c => ({ path: c.path, mode: modes.get(c.path) ?? '100644', type: 'blob', content: c.content }))
    });
    const commit = await this.request<{ sha: string }>('git/commits', 'POST', {
      message: `fix: RepoPilot verified repair for #${report.pr}\n\nRepoPilot-Run: ${report.id}`,
      tree: tree.sha, parents: [report.head]
    });
    if (existing[0]) {
      const prior = await this.request<{ tree: { sha: string }; parents: { sha: string }[] }>(`git/commits/${existing[0].head.sha}`);
      if (existing[0].state !== 'open' || prior.tree.sha !== tree.sha || prior.parents.length !== 1 || prior.parents[0]?.sha !== report.head) throw new Error('Existing repair PR does not match verified evidence.');
      return await this.current(report) ? existing[0].html_url : undefined;
    }
    if (!await this.current(report)) return undefined;
    // An existing ref from a interrupted publish is reusable only with the expected tree and parent.
    let ref: { object: { sha: string } } | undefined;
    try { ref = await this.request(`git/ref/heads/${branch}`); }
    catch (error) { if (!String(error).endsWith('HTTP 404')) throw error; }
    if (ref) {
      const previous = await this.request<{ tree: { sha: string }; parents: { sha: string }[] }>(`git/commits/${ref.object.sha}`);
      if (previous.tree.sha !== tree.sha || previous.parents[0]?.sha !== report.head || previous.parents.length !== 1) {
        throw new Error('Repair branch collision: refusing to overwrite.');
      }
    } else await this.request('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    if (!await this.current(report)) return undefined;
    const result = await this.request<{ html_url: string }>('pulls', 'POST', {
      title: `fix: verified repair for #${report.pr}`, head: branch, base: pr.head.ref, draft: true,
      body: markdownReport(report).slice(0, 60000)
    });
    return result.html_url;
  }
}
