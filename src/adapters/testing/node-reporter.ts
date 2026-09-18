// Trusted Node test reporter. Runs inside the test container and emits one JSON document.
interface Event { type: string; data: {
  name?: string; file?: string; nesting?: number; skip?: boolean | string; todo?: boolean | string;
  details?: { type?: string; duration_ms?: number; error?: { message?: string; code?: string; failureType?: string; exitCode?: number; signal?: string; cause?: { message?: string; code?: string } } };
}; }
export default async function* reporter(source: AsyncIterable<Event>) {
  const cases: { file: string; name: string; status: string; durationMs: number; failure?: string }[] = [];
  const infrastructureErrors: string[] = [], parents: string[] = [];
  for await (const { type, data } of source) {
    const depth = data.nesting ?? 0;
    if (type === 'test:start') { parents[depth] = data.name ?? ''; parents.length = depth + 1; }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const error = data.details?.error;
    if (data.details?.type === 'suite' || error?.failureType === 'subtestsFailed') continue;
    if (type === 'test:fail' && ['testCodeFailure', 'cancelledByParent'].includes(error?.failureType ?? '')
      && (!data.file || data.name === data.file || error?.exitCode !== undefined || error?.signal !== undefined)) {
      infrastructureErrors.push(error?.cause?.message ?? error?.message ?? 'Test file could not execute.'); continue;
    }
    if (!data.file || !data.name) { infrastructureErrors.push('Test result lacks file/name.'); continue; }
    cases.push({ file: data.file, name: [...parents.slice(0, depth), data.name].join(' > '),
      status: data.skip || data.todo ? 'skipped' : type === 'test:pass' ? 'passed' : 'failed',
      durationMs: data.details?.duration_ms ?? 0,
      failure: type === 'test:fail' ? [error?.cause?.code ?? error?.code, error?.cause?.message ?? error?.message].filter(Boolean).join(': ') : undefined });
  }
  yield JSON.stringify({ format: 'repopilot-node-v1', cases, infrastructureErrors });
}
