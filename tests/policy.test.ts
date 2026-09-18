import assert from 'node:assert/strict';
import test from 'node:test';
import { applyExceptions, checkPolicy, instructions, introducedFindings, loadPolicy } from '../src/domain/policy.js';
import { applyChanges, semanticFindings } from '../src/domain/repair.js';
import { safePath } from '../src/domain/snapshot.js';

const rules = JSON.stringify({ rules: [{ id: 'fk', extensions: ['.sql'], forbiddenText: 'FOREIGN KEY', message: 'No foreign keys.' }] });
test('candidate cannot delete trusted policy to pass review', () => {
  const base = new Map([['.repopilot/policy.json', rules]]);
  const head = new Map([['migration.sql', 'FOREIGN KEY (id) REFERENCES users(id);']]);
  const result = introducedFindings(base, head, loadPolicy(base));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.source, '.repopilot/policy.json#fk');
});
test('AST rules inspect calls rather than comments and strings', () => {
  const files = new Map([['.repopilot/policy.json', JSON.stringify({ rules: [{ id: 'skip', kind: 'forbid-call', callee: 'test.skip', message: 'No skips.' }] })],
    ['a.ts', '// test.skip("comment")\nconst example = "test.skip()";\ntest["skip"]("real", () => {});']]);
  const found = checkPolicy(files, loadPolicy(files));
  assert.equal(found.length, 1); assert.equal(found[0]?.line, 3);
});
test('overlapping contradictory AST rules fail; expired exceptions no longer suppress', () => {
  const rules = [{ id: 'forbid', kind: 'forbid-call', callee: 'audit', message: 'No audit.' },
    { id: 'require', kind: 'require-call', callee: 'audit', scope: 'src', message: 'Audit required.' }];
  assert.throws(() => loadPolicy(new Map([['.repopilot/policy.json', JSON.stringify({ rules })]])), /Conflicting/);
  const files = new Map([['.repopilot/policy.json', JSON.stringify({ rules: [rules[0]], exceptions: [
    { ruleId: 'forbid', path: 'src/a.ts', reason: 'Temporary migration.', expiresAt: '2026-10-01T00:00:00Z' }] })], ['src/a.ts', 'audit();']]);
  const policy = loadPolicy(files), findings = checkPolicy(files, policy);
  assert.equal(applyExceptions(findings, policy, new Date('2026-09-01')).suppressed.length, 1);
  assert.equal(applyExceptions(findings, policy, new Date('2026-11-01')).findings.length, 1);
});
test('line shifts preserve historical findings but duplicate violations are new', () => {
  const base = new Map([['.repopilot/policy.json', rules], ['old.sql', 'FOREIGN KEY (id)']]);
  const head = new Map(base); head.set('old.sql', '\nFOREIGN KEY (id)\nFOREIGN KEY (id)');
  const result = introducedFindings(base, head, loadPolicy(base));
  assert.equal(result.historical.length, 1); assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.line, 3);
});
test('nested instructions apply only to their own subtree in depth order', () => {
  const base = new Map([['AGENTS.md', 'root'], ['src/AGENTS.md', 'source'], ['src/api/AGENTS.md', 'api'], ['src2/AGENTS.md', 'other']]);
  assert.deepEqual(instructions(base, 'src/api/a.ts').map(x => x.content), ['root', 'source', 'api']);
  assert.deepEqual(instructions(base, 'src2/a.ts').map(x => x.content), ['root', 'other']);
});
test('unsafe filesystem paths are rejected on Windows and Linux', () => {
  for (const path of ['../x', '/x', 'C:/x', 'src\\x', '.git/config', 'src/.GIT/config', 'CON.txt', 'a/../x', 'a./x', 'a\n.ts']) assert.equal(safePath(path), false, path);
  assert.equal(safePath('src/valid.ts'), true);
});
test('repairs cannot modify tests, instructions, workflows, or manifests', () => {
  const head = new Map([['src/a.test.ts', 'test'], ['src/a.ts', 'bad']]);
  for (const path of ['src/a.test.ts', 'AGENTS.md', '.github/workflows/ci.yml', 'package.json', '../oops.ts']) {
    assert.throws(() => applyChanges(head, [{ path, content: '' }]));
  }
  assert.equal(applyChanges(head, [{ path: 'src/a.ts', content: 'good' }]).get('src/a.ts'), 'good');
  assert.throws(() => applyChanges(head, [{ path: 'src/a.ts', content: '' }, { path: 'src/a.ts', content: '' }]));
});
test('semantic findings must cite trusted scoped instructions and a changed file', () => {
  const base = new Map([['AGENTS.md', 'no bad'], ['a.ts', 'good']]), head = new Map(base); head.set('a.ts', 'bad');
  const f = { ruleId: 'rule', path: 'a.ts', line: 1, message: 'bad', severity: 'error' as const, source: 'AGENTS.md', ruleQuote: 'no bad', evidence: 'bad' };
  assert.equal(semanticFindings({ findings: [f], changes: [], scenarios: [], summary: '' }, base, head)[0]?.kind, 'semantic');
  assert.throws(() => semanticFindings({ findings: [{ ...f, source: 'made-up.md' }], changes: [], scenarios: [], summary: '' }, base, head));
});
