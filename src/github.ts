import type { PullRequest, Report } from './types.js';

export class GitHub {
  constructor(readonly repository: string, private token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository.');
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com/repos/${this.repository}/${path}`, {
      method, signal: AbortSignal.timeout(30000), redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RepoPilot/0.1',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return await response.json() as T;
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
    return pr.state === 'open' && pr.head.repo?.full_name === this.repository
      && pr.head.sha === report.head && pr.base.sha === report.base ? pr : undefined;
  }
  async publish(report: Report): Promise<string | undefined> {
    if (!this.token) throw new Error('GITHUB_TOKEN is required to publish.');
    if (report.repository !== this.repository || report.status !== 'verified' || !report.changes.length
      || report.tests.repaired?.status !== 'passed') throw new Error('Only verified repairs can be published.');
    const pr = await this.current(report);
    if (!pr) return undefined;
    const branch = `autofix/pr-${report.pr}/${report.id}`;
    const existing = await this.request<{ html_url: string }[]>(`pulls?state=all&head=${encodeURIComponent(this.repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(pr.head.ref)}`);
    if (existing[0]) return existing[0].html_url;
    // Git data objects can be retried without moving a ref or touching the source PR branch.
    const parent = await this.request<{ tree: { sha: string } }>(`git/commits/${report.head}`);
    const tree = await this.request<{ sha: string }>('git/trees', 'POST', {
      base_tree: parent.tree.sha,
      tree: report.changes.map(c => ({ path: c.path, mode: '100644', type: 'blob', content: c.content }))
    });
    const commit = await this.request<{ sha: string }>('git/commits', 'POST', {
      message: `fix: RepoPilot verified repair for #${report.pr}\n\nRepoPilot-Run: ${report.id}`,
      tree: tree.sha, parents: [report.head]
    });
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
      body: `RepoPilot run \`${report.id}\` for #${report.pr}.\n\nTested source: \`${report.head}\`\nBase: \`${report.base}\`\n\nThe repair passed the configured test command and policy recheck. Review the changes before merging.\n\nNo automatic merge is performed.`
    });
    return result.html_url;
  }
}
