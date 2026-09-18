import type { Report } from '../domain/types.js';
const safe = (value: string) => value.replace(/@/g, '@\u200b').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
function block(value: string): string {
  const fence = '`'.repeat(Math.max(3, ...Array.from(value.matchAll(/`+/g), m => m[0].length + 1)));
  return fence + '\n' + safe(value) + '\n' + fence;
}
export function markdownReport(report: Report): string {
  const lines = ['# RepoPilot verification', '', 'Run: ' + report.id, 'Status: ' + report.status,
    'Repository: ' + report.repository, 'Base: ' + report.base, 'Head: ' + report.head,
    'Description hash: ' + report.descriptionHash, 'Rerun of: ' + (report.rerunOf ?? '—'), '',
    '## Findings', ...report.findings.map(f => '- ' + safe(f.severity + ' ' + f.path + ':' + f.line + ' [' + f.ruleId + '] ' + f.message)),
    '', 'Historical findings: ' + report.historical.length, 'Suppressed findings: ' + report.suppressed.length,
    ...report.suppressed.map(s => '- ' + safe(s.finding.ruleId + ': ' + s.reason + ' (expires ' + s.expiresAt + ')')),
    '', '## Test plan', safe(report.plan?.summary ?? 'No generated test plan.'),
    ...(report.plan?.scenarios.map(s => '- ' + safe('[' + s.kind + '] ' + s.testFile + ': ' + s.name + ' — ' + s.requirement
      + (s.requirementQuote ? ' | Requirement quote: ' + s.requirementQuote : ''))) ?? []),
    '', '## Test assessment',
    ...(report.testAssessment?.cases.map(c => '- ' + safe(c.outcome + ' ' + c.id + ': ' + c.reason)) ?? []),
    ...(report.testAssessment?.reasons.map(reason => '- ' + safe(reason)) ?? []),
    '', '## Runner evidence'];
  for (const item of report.evidence) {
    lines.push('', '### ' + safe(item.phase) + ' / attempt ' + item.attempt,
      'Status: ' + item.result.status + '; duration: ' + item.result.durationMs + ' ms',
      ...item.result.cases.map(c => '- ' + safe(c.status + ' ' + c.file + ' :: ' + c.name + (c.fingerprint ? ' [' + c.fingerprint + ']' : ''))),
      block(item.result.output.slice(0, 4000)));
  }
  lines.push('', '## Repair attempts', ...report.repairs.map(r => '- ' + safe(r.number + ': ' + r.summary + ' — ' + (r.accepted ? 'accepted' : r.reason ?? 'rejected'))),
    '', '## Notes', ...report.notes.map(n => '- ' + safe(n)), '',
    'Agent calls: ' + (report.agentUsage?.calls ?? 0) + '; reported tokens: ' + (report.agentUsage?.tokens ?? 0),
    '', 'Full outputs and patches are retained in the local JSON report. Human review is required before merging.');
  return lines.join('\n');
}
