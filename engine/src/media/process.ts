import { spawn } from 'node:child_process';

/**
 * The one subprocess seam media helpers share: argv + optional stdin bytes in,
 * bounded stdout/stderr out. Tests fake `RunCommand`; production spawns through
 * `spawnProcess`, which names the two failures callers translate into their own
 * error types — a binary that does not exist, and one that ran too long.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (command: string, args: string[], opts: { input?: Uint8Array; timeoutMs?: number }) => Promise<RunResult>;

export type ProcessFailure = 'missing' | 'timed_out';

/** Spawn-level failure, before stderr can even be read — callers map this to their own named errors. */
export class ProcessError extends Error {
  constructor(
    message: string,
    readonly reason: ProcessFailure,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** The real runner: argv only, optional stdin bytes, output kept in memory and bounded by the timeout. */
export const spawnProcess: RunCommand = (command, args, opts) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new ProcessError(`${command} did not answer within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds.`, 'timed_out'));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new ProcessError(`${command} is not installed on this device.`, 'missing')
          : error,
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    if (opts.input) {
      child.stdin.on('error', () => {});
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
