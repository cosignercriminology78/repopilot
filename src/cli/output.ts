import { resolve } from 'node:path';
import type { Config } from '../domain/config.js';
import type { Report } from '../domain/types.js';
export function reportSummary(report: Report, config: Config): string {
  return JSON.stringify({ id: report.id, status: report.status, findings: report.findings.length,
    tests: report.tests.head.status, semantic: report.semantic,
    report: resolve(config.dataDir, report.id + '.json'), pullRequest: report.pullRequestUrl });
}
export function reportExitCode(report: Report): number {
  return ['passed', 'verified', 'published'].includes(report.status) ? 0 : 2;
}
