import { watch } from '../../application/watch.js';
import type { CliValues } from '../args.js';
import { reportSummary } from '../output.js';
import type { Output, Runtime } from '../runtime.js';
export async function watchCommand(values: CliValues, runtime: Runtime, output: Output): Promise<void> {
  await watch(runtime, !!values.once, report => output.write(reportSummary(report, runtime.config)), message => output.error(message));
}
