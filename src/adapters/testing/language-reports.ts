import { posix } from 'node:path';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import type { Snapshot } from '../../domain/types.js';

export const XML_MARKER = '\nREPOPILOT_XML_REPORT\n';
interface Row { file: string; name: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number; failure?: string; }
interface XmlNode { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string; }
export function junitRows(output: string, files: Snapshot): { rows: Row[]; errors: string[] } {
  const documents = output.includes(XML_MARKER) ? output.split(XML_MARKER).slice(1) : [output];
  const rows: Row[] = [], errors: string[] = [];
  for (const document of documents) {
    const stack: XmlNode[] = []; let root: XmlNode | undefined;
    const parser = new SaxesParser({ xmlns: false });
    parser.on('doctype', () => { throw new Error('DTD is forbidden in test reports.'); });
    parser.on('error', error => { throw error; });
    parser.on('opentag', tag => {
      if (stack.length > 32) throw new Error('XML nesting exceeds limit.');
      const node: XmlNode = { name: tag.name, attributes: tag.attributes as Record<string, string>, children: [], text: '' };
      if (stack.length) stack.at(-1)!.children.push(node); else root = node;
      stack.push(node);
    });
    parser.on('text', text => { if (stack.length) stack.at(-1)!.text += text; });
    parser.on('cdata', text => { if (stack.length) stack.at(-1)!.text += text; });
    parser.on('closetag', () => { stack.pop(); });
    parser.write(document).close();
    if (!root || !['testsuite', 'testsuites'].includes(root.name)) throw new Error('Expected JUnit test suite.');
    const visit = (node: XmlNode): number => {
      if (node.name === 'testcase') {
        const { name, classname = '', file, time = '0' } = node.attributes;
        if (!name || !Number.isFinite(Number(time)) || Number(time) < 0) throw new Error('Invalid JUnit case.');
        const javaPath = classname.replaceAll('.', '/') + '.java';
        const matches = file ? [file] : [...files.keys()].filter(path => path === javaPath || path.endsWith('/' + javaPath));
        if (matches.length !== 1) throw new Error('JUnit case requires an unambiguous source file.');
        const failed = node.children.filter(child => child.name === 'failure');
        if (failed.length && node.children.some(child => child.name === 'skipped')) errors.push('Contradictory JUnit case outcomes.');
        if (node.children.some(child => child.name === 'error')) errors.push('JUnit setup/collection/execution error.');
        rows.push({ file: file ? matches[0]! : '/tmp/work/' + matches[0]!, name: classname ? classname + ' :: ' + name : name,
          status: node.children.some(c => c.name === 'skipped') ? 'skipped' : failed.length ? 'failed' : 'passed',
          durationMs: Number(time) * 1000, failure: failed.map(f => [f.attributes.message, f.text].filter(Boolean).join('\n')).join('\n') || undefined });
        return 1;
      }
      const start = rows.length;
      const count = node.children.reduce((sum, child) => sum + visit(child), 0);
      if (node.name === 'testsuite' || node.name === 'testsuites') {
        for (const attribute of ['tests', 'errors', 'failures', 'skipped']) {
          const value = node.attributes[attribute];
          if (value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) throw new Error('Invalid JUnit suite counter.');
        }
        if (node.attributes.tests !== undefined && Number(node.attributes.tests) !== count) errors.push('JUnit test count mismatch.');
        if (Number(node.attributes.errors ?? 0) > 0) errors.push('JUnit suite reported errors.');
        for (const [attribute, status] of [['failures', 'failed'], ['skipped', 'skipped']] as const) {
          if (node.attributes[attribute] !== undefined && Number(node.attributes[attribute]) !== rows.slice(start).filter(row => row.status === status).length) errors.push('JUnit outcome count mismatch.');
        }
      }
      return count;
    };
    visit(root);
  }
  return { rows, errors };
}

const eventSchema = z.object({ Action: z.string(), Package: z.string().optional(), Test: z.string().optional(),
  Elapsed: z.number().nonnegative().optional(), Output: z.string().optional(), FailedBuild: z.string().optional() });
function goSourceIndex(files: Snapshot): Map<string, string[]> {
  const modules = [...files].filter(([path]) => path === 'go.mod' || path.endsWith('/go.mod'))
    .map(([path, content]) => {
      const match = content.match(/^module\s+(?:"([^"]+)"|(\S+))/m);
      return { root: path === 'go.mod' ? '' : path.slice(0, -7), module: match?.[1] ?? match?.[2] };
    }).filter(module => module.module).sort((a, b) => b.root.length - a.root.length);
  const index = new Map<string, string[]>();
  for (const [path, source] of files) {
    if (!path.endsWith('_test.go')) continue;
    const directory = posix.dirname(path);
    const mod = modules.find(m => !m.root || directory === m.root || directory.startsWith(m.root + '/'));
    if (!mod) continue;
    const relative = directory === '.' ? '' : mod.root ? directory.slice(mod.root.length).replace(/^\//, '') : directory;
    const pkg = mod.module + (relative ? '/' + relative : '');
    for (const match of source.matchAll(/^func\s+((?:Test|Example|Fuzz)\w*)\s*\(/gm)) {
      const key = JSON.stringify([pkg, match[1]]);
      index.set(key, [...(index.get(key) ?? []), path]);
    }
  }
  return index;
}
export function goRows(output: string, files: Snapshot): { rows: Row[]; errors: string[] } {
  const sources = goSourceIndex(files);
  const rows: Row[] = [], errors: string[] = [], logs = new Map<string, string>();
  const started = new Set<string>(), completed = new Set<string>(), packageFailures = new Set<string>();
  const packageEnds = new Set<string>(), packages = new Set<string>();
  const failedPackages = new Set<string>();
  const passedPackages = new Set<string>();
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    const event = eventSchema.parse(JSON.parse(line));
    if (event.FailedBuild || event.Action === 'build-fail') errors.push('Go build failed.');
    if (!event.Package) { if (!event.Action.startsWith('build-')) errors.push('Missing Go package identity.'); continue; }
    packages.add(event.Package);
    const key = JSON.stringify([event.Package, event.Test]);
    if (event.Action === 'output') logs.set(key, (logs.get(key) ?? '') + (event.Output ?? ''));
    if (!event.Test) {
      if (['pass', 'fail', 'skip'].includes(event.Action)) packageEnds.add(event.Package);
      if (event.Action === 'fail') packageFailures.add(event.Package);
      if (event.Action === 'pass') passedPackages.add(event.Package);
      continue;
    }
    if (event.Action === 'run') started.add(key);
    if (!['pass', 'fail', 'skip'].includes(event.Action)) continue;
    if (!started.has(key) || completed.has(key)) throw new Error('Go case missing run event or has duplicate completion.');
    completed.add(key);
    if (event.Action === 'fail') failedPackages.add(event.Package);
    const functionName = event.Test.split('/')[0]!;
    const matches = sources.get(JSON.stringify([event.Package, functionName])) ?? [];
    if (matches.length !== 1) throw new Error('Go test cannot be mapped to one source file.');
    rows.push({ file: '/tmp/work/' + matches[0]!, name: event.Test, status: event.Action === 'pass' ? 'passed' : event.Action === 'fail' ? 'failed' : 'skipped',
      durationMs: (event.Elapsed ?? 0) * 1000, failure: event.Action === 'fail' ? logs.get(key)?.replace(/^\s*--- (PASS|FAIL|SKIP):.*$/gm, '').trim() || 'Go reported test failure: ' + event.Test : undefined });
  }
  if ([...started].some(key => !completed.has(key)) || [...packages].some(pkg => !packageEnds.has(pkg))) errors.push('Incomplete Go test stream.');
  for (const pkg of packageFailures) if (!failedPackages.has(pkg)) errors.push('Go package failed outside a test.');
  for (const pkg of failedPackages) if (passedPackages.has(pkg)) errors.push('Contradictory Go package outcome.');
  return { rows, errors };
}
