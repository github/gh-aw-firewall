import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { WrapperConfig } from './types';
import {
  assertPrivateCommandOutputRootIsolated,
  findDockerSocketExposingMount,
} from './enclave/mount-policy';
import { isGvisorRuntime, runtimeUsesComposeAgent } from './container-runtime';

export const PROTECTED_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

export type CapturedOutputStream = 'stdout' | 'stderr';
export type CommandAttemptOutcome = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed';

interface StreamState {
  file: string;
  fd: number;
  observedBytes: number;
  capturedBytes: number;
}

interface AttemptState {
  attemptId: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  outcome: 'not_started' | CommandAttemptOutcome;
  logsDrained?: boolean;
  streams: Record<CapturedOutputStream, StreamState>;
}

export interface ProtectedCommandOutputCapture {
  readonly invocationId: string;
  beginAttempt(attempt: number): void;
  recordOutput(attempt: number, stream: CapturedOutputStream, chunk: Buffer): void;
  finishAttempt(
    attempt: number,
    result: { exitCode: number; outcome: Exclude<CommandAttemptOutcome, 'running'>; logsDrained: boolean },
  ): void;
  finishCommand(exitCode: number | undefined, outcome: Exclude<CommandAttemptOutcome, 'running'>): void;
  waitForCommandCompletion(): Promise<void>;
  setTeardown(outcome: 'complete' | 'failed'): void;
  close(): void;
}

interface CaptureMetadata {
  schemaVersion: 1;
  invocationId: string;
  runtime: string;
  ordering: string;
  maxBytes: number;
  status: 'running' | 'complete' | 'incomplete';
  command: { outcome: 'pending' | CommandAttemptOutcome; exitCode?: number };
  teardown: 'pending' | 'complete' | 'failed';
  observedBytes: number;
  capturedBytes: number;
  truncated: boolean;
  captureFailure?: string;
  attempts: Array<{
    attemptId: string;
    stdout: { file: string; observedBytes: number; capturedBytes: number };
    stderr: { file: string; observedBytes: number; capturedBytes: number };
    startedAt?: string;
    endedAt?: string;
    exitCode?: number;
    outcome: AttemptState['outcome'];
    logsDrained?: boolean;
  }>;
}

function writeAll(fd: number, bytes: Buffer, position?: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, position === undefined ? null : position + offset);
    if (written <= 0) throw new Error('zero-byte write');
    offset += written;
  }
}

function openPrivateFile(file: string): number {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== (process.getuid?.() ?? stat.uid)) {
    fs.closeSync(fd);
    throw new Error(`Refusing unsafe protected output file: ${file}`);
  }
  fs.fchmodSync(fd, 0o600);
  return fd;
}

class ProtectedCommandOutputCaptureSession implements ProtectedCommandOutputCapture {
  readonly invocationId = randomUUID();
  private readonly metadataFd: number;
  private readonly attempts: AttemptState[];
  private currentAttempt?: number;
  private commandOutcome: CaptureMetadata['command']['outcome'] = 'pending';
  private commandExitCode?: number;
  private teardown: CaptureMetadata['teardown'] = 'pending';
  private truncated = false;
  private captureFailure?: string;
  private closed = false;
  private metadataInitialized = false;
  private commandStarted = false;
  private resolveCommandCompletion!: () => void;
  private readonly commandCompletion = new Promise<void>(resolve => {
    this.resolveCommandCompletion = resolve;
  });

  constructor(
    private readonly directory: string,
    private readonly runtime: string,
    private readonly maxBytes: number,
    maxAttempts: number,
  ) {
    fs.mkdirSync(directory, { mode: 0o700 });
    const dirStat = fs.lstatSync(directory);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.uid !== (process.getuid?.() ?? dirStat.uid)) {
      throw new Error(`Refusing unsafe protected output directory: ${directory}`);
    }
    fs.chmodSync(directory, 0o700);

    const openedFds: number[] = [];
    let metadataFd: number | undefined;
    const attempts: AttemptState[] = [];
    try {
      metadataFd = openPrivateFile(path.join(directory, 'metadata.json'));
      openedFds.push(metadataFd);
      for (let index = 1; index <= maxAttempts; index++) {
        const prefix = `attempt-${String(index).padStart(3, '0')}`;
        const stdoutFile = `${prefix}.stdout.bin`;
        const stderrFile = `${prefix}.stderr.bin`;
        const stdoutPath = path.join(directory, stdoutFile);
        const stdoutFd = openPrivateFile(stdoutPath);
        openedFds.push(stdoutFd);
        const stderrPath = path.join(directory, stderrFile);
        const stderrFd = openPrivateFile(stderrPath);
        openedFds.push(stderrFd);
        attempts.push({
          attemptId: `${this.invocationId}:${index}`,
          outcome: 'not_started',
          streams: {
            stdout: { file: stdoutFile, fd: stdoutFd, observedBytes: 0, capturedBytes: 0 },
            stderr: { file: stderrFile, fd: stderrFd, observedBytes: 0, capturedBytes: 0 },
          },
        });
      }
    } catch (error) {
      for (const fd of openedFds) fs.closeSync(fd);
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }

    this.metadataFd = metadataFd!;
    this.attempts = attempts;
    try {
      this.writeMetadata();
      this.metadataInitialized = true;
    } catch (error) {
      for (const attempt of this.attempts) {
        for (const stream of Object.values(attempt.streams)) fs.closeSync(stream.fd);
      }
      fs.closeSync(this.metadataFd);
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  beginAttempt(attempt: number): void {
    const state = this.getAttempt(attempt);
    state.startedAt = new Date().toISOString();
    state.outcome = 'running';
    this.commandStarted = true;
    this.currentAttempt = attempt;
    this.writeMetadata();
  }

  recordOutput(attempt: number, stream: CapturedOutputStream, chunk: Buffer): void {
    const state = this.getAttempt(attempt).streams[stream];
    state.observedBytes += chunk.length;
    if (this.captureFailure) return;

    const remaining = Math.max(0, this.maxBytes - this.totalCapturedBytes());
    const length = Math.min(chunk.length, remaining);
    if (length < chunk.length) this.truncated = true;
    if (length === 0) return;

    try {
      writeAll(state.fd, chunk.subarray(0, length));
      state.capturedBytes += length;
    } catch (error) {
      this.captureFailure = `write ${stream} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  finishAttempt(
    attempt: number,
    result: { exitCode: number; outcome: Exclude<CommandAttemptOutcome, 'running'>; logsDrained: boolean },
  ): void {
    const state = this.getAttempt(attempt);
    state.endedAt = new Date().toISOString();
    state.exitCode = result.exitCode;
    state.outcome = result.outcome;
    state.logsDrained = result.logsDrained;
    for (const stream of Object.values(state.streams)) {
      try {
        fs.fsyncSync(stream.fd);
      } catch (error) {
        this.captureFailure ??= `flush failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (this.currentAttempt === attempt) this.currentAttempt = undefined;
    this.writeMetadata();
  }

  finishCommand(exitCode: number | undefined, outcome: Exclude<CommandAttemptOutcome, 'running'>): void {
    if (this.commandOutcome !== 'pending') return;
    if (exitCode !== undefined) this.commandExitCode = exitCode;
    this.commandOutcome = outcome;
    if (outcome === 'failed' && this.currentAttempt !== undefined) {
      const attempt = this.getAttempt(this.currentAttempt);
      attempt.endedAt = new Date().toISOString();
      attempt.outcome = 'failed';
      attempt.logsDrained = false;
      this.currentAttempt = undefined;
    }
    this.writeMetadata();
    this.resolveCommandCompletion();
  }

  waitForCommandCompletion(): Promise<void> {
    return this.commandStarted ? this.commandCompletion : Promise.resolve();
  }

  setTeardown(outcome: 'complete' | 'failed'): void {
    this.teardown = outcome;
    this.writeMetadata();
  }

  close(): void {
    if (this.closed) return;
    for (const attempt of this.attempts) {
      for (const stream of Object.values(attempt.streams)) {
        try {
          fs.closeSync(stream.fd);
        } catch (error) {
          this.captureFailure ??= `close failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    this.writeMetadata();
    try {
      fs.closeSync(this.metadataFd);
    } catch {
      this.captureFailure ??= 'metadata close failed';
    } finally {
      this.closed = true;
    }
  }

  private getAttempt(number: number): AttemptState {
    const attempt = this.attempts.find((candidate, index) => index + 1 === number);
    if (!attempt) throw new Error(`Protected output capture has no attempt ${number}`);
    return attempt;
  }

  private totalCapturedBytes(): number {
    return this.attempts.reduce((sum, attempt) =>
      sum + Object.values(attempt.streams).reduce((streamSum, stream) => streamSum + stream.capturedBytes, 0), 0);
  }

  private buildMetadata(): CaptureMetadata {
    const observedBytes = this.attempts.reduce((sum, attempt) =>
      sum + Object.values(attempt.streams).reduce((streamSum, stream) => streamSum + stream.observedBytes, 0), 0);
    const capturedBytes = this.totalCapturedBytes();
    const complete = this.commandOutcome === 'exited'
      && this.teardown === 'complete'
      && !this.truncated
      && !this.captureFailure
      && this.attempts.filter(attempt => attempt.outcome !== 'not_started').every(attempt => attempt.logsDrained);

    return {
      schemaVersion: 1,
      invocationId: this.invocationId,
      runtime: this.runtime,
      ordering: 'stdout and stderr are separate byte streams; ordering is guaranteed only within each stream and attempt',
      maxBytes: this.maxBytes,
      status: this.commandOutcome === 'pending' ? 'running' : complete ? 'complete' : 'incomplete',
      command: { outcome: this.commandOutcome, ...(this.commandExitCode === undefined ? {} : { exitCode: this.commandExitCode }) },
      teardown: this.teardown,
      observedBytes,
      capturedBytes,
      truncated: this.truncated,
      ...(this.captureFailure ? { captureFailure: this.captureFailure } : {}),
      attempts: this.attempts.map(attempt => ({
        attemptId: attempt.attemptId,
        stdout: {
          file: attempt.streams.stdout.file,
          observedBytes: attempt.streams.stdout.observedBytes,
          capturedBytes: attempt.streams.stdout.capturedBytes,
        },
        stderr: {
          file: attempt.streams.stderr.file,
          observedBytes: attempt.streams.stderr.observedBytes,
          capturedBytes: attempt.streams.stderr.capturedBytes,
        },
        ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
        ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
        ...(attempt.exitCode === undefined ? {} : { exitCode: attempt.exitCode }),
        outcome: attempt.outcome,
        ...(attempt.logsDrained === undefined ? {} : { logsDrained: attempt.logsDrained }),
      })),
    };
  }

  private writeMetadata(): void {
    if (this.closed) return;
    try {
      const contents = Buffer.from(`${JSON.stringify(this.buildMetadata(), null, 2)}\n`);
      fs.ftruncateSync(this.metadataFd, 0);
      writeAll(this.metadataFd, contents, 0);
      fs.fsyncSync(this.metadataFd);
    } catch (error) {
      if (!this.metadataInitialized) throw error;
      this.captureFailure ??= `metadata update failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export function prepareProtectedCommandOutputCapture(
  config: WrapperConfig,
): ProtectedCommandOutputCapture | undefined {
  const directory = config.commandOutputCaptureDir;
  if (!directory) return undefined;
  assertProtectedCommandOutputCaptureSupported(config);

  assertPrivateCommandOutputRootIsolated(config, directory);
  const maxAttempts = isGvisorRuntime(config.containerRuntime) ? 2 : 1;
  return new ProtectedCommandOutputCaptureSession(
    directory,
    config.containerRuntime ?? 'docker',
    config.commandOutputCaptureMaxBytes ?? PROTECTED_COMMAND_OUTPUT_MAX_BYTES,
    maxAttempts,
  );
}

export function assertProtectedCommandOutputCaptureSupported(config: WrapperConfig): void {
  const directory = config.commandOutputCaptureDir;
  const maxBytes = config.commandOutputCaptureMaxBytes;
  if (!directory) {
    if (maxBytes !== undefined) throw new Error('--capture-command-output-max-bytes requires --capture-command-output');
    return;
  }
  if (!path.isAbsolute(directory)) throw new Error('Protected command output directory must be an absolute path');
  if (config.tty) throw new Error('Protected command output capture does not support TTY mode');
  if (config.enableDind || findDockerSocketExposingMount(config)) {
    throw new Error('Protected command output capture is not supported when the agent can access a Docker socket');
  }
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROTECTED_COMMAND_OUTPUT_MAX_BYTES)) {
    throw new Error(`Protected command output byte limit must be an integer between 1 and ${PROTECTED_COMMAND_OUTPUT_MAX_BYTES}`);
  }
  if (!runtimeUsesComposeAgent(config.containerRuntime)) {
    throw new Error(`Protected command output capture is not supported by the "${config.containerRuntime}" runtime`);
  }
}
