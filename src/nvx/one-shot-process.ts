import { promises as fs } from 'fs';
import { constants as osConstants } from 'os';
import { spawn } from 'child_process';
import type { Readable } from 'stream';
import { formatError } from './one-shot-validation';

const NVX_TERMINATION_GRACE_MS = 2_000;

export interface NvxProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  onStdout(chunk: Buffer): Promise<void>;
  onStderr(chunk: Buffer): Promise<void>;
}

export interface NvxProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export async function runNvxProcess(request: NvxProcessRequest): Promise<NvxProcessResult> {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutPump = pump(child.stdout, request.onStdout);
  const stderrPump = pump(child.stderr, request.onStderr);
  let timedOut = false;
  let cancelled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let pendingExit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveCompletion!: (result: NvxProcessResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<NvxProcessResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      pendingExit = { exitCode, signal };
      if (forceKillTimer === undefined) {
        resolveCompletion({ exitCode, signal, timedOut, cancelled });
      }
    });
  });
  const terminate = (reason: 'timeout' | 'cancelled'): void => {
    if (timedOut || cancelled) return;
    if (reason === 'timeout') timedOut = true;
    else cancelled = true;
    const terminationError = killProcessTree(
      child.pid,
      'SIGTERM',
      () => child.kill('SIGTERM'),
    );
    if (terminationError) {
      rejectCompletion(terminationError);
      return;
    }
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      void forceKill();
    }, NVX_TERMINATION_GRACE_MS);
  };
  const forceKill = async (): Promise<void> => {
    const forceKillError = pendingExit
      ? await killExitedProcessGroup(child.pid, 'SIGKILL')
      : killProcessTree(child.pid, 'SIGKILL', () => child.kill('SIGKILL'));
    if (forceKillError) {
      rejectCompletion(forceKillError);
    } else if (pendingExit) {
      // Keep escalation active after the launcher exits so descendants cannot survive.
      resolveCompletion({
        exitCode: pendingExit.exitCode,
        signal: pendingExit.signal,
        timedOut,
        cancelled,
      });
    }
  };
  const timeout = request.timeoutMs === undefined
    ? undefined
    : setTimeout(() => terminate('timeout'), request.timeoutMs);
  const onAbort = (): void => terminate('cancelled');
  request.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (request.abortSignal?.aborted) onAbort();
  try {
    const result = await completion;
    await Promise.all([stdoutPump, stderrPump]);
    return result;
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKillTimer);
    request.abortSignal?.removeEventListener('abort', onAbort);
  }
}

async function pump(
  source: Readable | null,
  destination: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  if (!source) return;
  for await (const chunk of source) {
    await destination(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => boolean,
): Error | undefined {
  if (pid === undefined) return new Error('NVX process has no PID');
  try {
    if (process.platform === 'win32') {
      if (!fallback()) return new Error(`Failed to signal NVX process with ${signal}`);
    } else {
      process.kill(-pid, signal);
    }

    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return undefined;
    try {
      if (fallback()) return undefined;
    } catch (fallbackError) {
      return new Error(
        `Failed to signal NVX process group with ${signal}: ${formatError(fallbackError)}`,
      );
    }
    return new Error(
      `Failed to signal NVX process group with ${signal}: ${formatError(error)}`,
    );
  }
}

async function killExitedProcessGroup(
  pgid: number | undefined,
  signal: NodeJS.Signals,
): Promise<Error | undefined> {
  if (pgid === undefined) return new Error('NVX process has no PID');
  try {
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[2] === String(pgid)) process.kill(Number(entry), signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
      }
    }
    return undefined;
  } catch (error) {
    return new Error(
      `Failed to signal exited NVX process group with ${signal}: ${formatError(error)}`,
    );
  }
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 128;
  return 128 + (osConstants.signals[signal] ?? 0);
}
