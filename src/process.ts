import { spawn } from 'node:child_process';

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; }
export function execute(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number;
} = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false, bytes = 0, tooLarge = false;
    const max = options.maxBytes ?? 4 * 1024 * 1024;
    const append = (data: Buffer, error: boolean) => {
      bytes += data.length;
      if (bytes > max) { tooLarge = true; child.kill(); return; }
      if (error) stderr += data.toString(); else stdout += data.toString();
    };
    child.stdout.on('data', data => append(data, false));
    child.stderr.on('data', data => append(data, true));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (tooLarge) reject(new Error('Process output exceeded the configured limit.'));
      else resolve({ code, stdout, stderr, timedOut });
    });
  });
}
export async function checked(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await execute(command, args, { cwd });
  if (result.code !== 0 || result.timedOut) throw new Error(`${command} failed: ${result.stderr.slice(0, 2000)}`);
  return result.stdout;
}
