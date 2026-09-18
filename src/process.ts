import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { throwIfAborted } from './control.js';

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; }
export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
}
export function execute(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, bytes = 0, tooLarge = false;
    const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
    let stopped = false;
    const kill = () => {
      if (stopped || !child.pid) return;
      stopped = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const append = (data: Buffer, error: boolean) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) { tooLarge = true; kill(); return; }
      if (error) stderr += err.write(data); else stdout += out.write(data);
    };
    child.stdout.on('data', data => append(data, false)); child.stderr.on('data', data => append(data, true));
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 60000);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', kill); };
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup(); stdout += out.end(); stderr += err.end();
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (tooLarge) reject(new Error('Process output exceeded the configured limit.'));
      else resolve({ code, stdout, stderr, timedOut });
    });
  });
}
export async function checked(command: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  const result = await execute(command, args, { cwd, signal });
  if (result.code !== 0 || result.timedOut) throw new Error(`${command} failed: ${result.stderr.slice(0, 2000)}`);
  return result.stdout;
}
