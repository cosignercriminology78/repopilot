import { parseArgs } from 'node:util';
import { VERSION } from '../shared/version.js';
export function parseCli(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    once: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' }, format: { type: 'string' },
    status: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
    apply: { type: 'boolean' }, expected: { type: 'string' }
  } });
}
export type CliValues = ReturnType<typeof parseCli>['values'];
export const help = `RepoPilot ${VERSION} — local-first repository verification

  repopilot --version
  repopilot init --config config.local.json --repo OWNER/REPOSITORY
  repopilot doctor --config config.local.json
  repopilot recover --config config.local.json
  repopilot recover --config config.local.json --apply --expected PREVIEW_TOKEN

  npm run dev -- check --config config.local.json --repo /path/to/repo --base main --head feature
  npm run dev -- watch --config config.local.json [--once]
  npm run dev -- tasks list --config config.local.json [--status running] [--limit 20] [--offset 0]
  npm run dev -- tasks show TASK_ID --config config.local.json [--format json|markdown]
  npm run dev -- tasks cancel TASK_ID --config config.local.json
  npm run dev -- tasks resume TASK_ID --config config.local.json
  npm run dev -- tasks rerun TASK_ID --config config.local.json

check: verify local commit snapshots without modifying the source repository.
watch: poll GitHub PRs; persist reports; optionally publish verified repair branches.
Configuration lives outside tested snapshots. See README.md for Docker and authentication setup.`;
