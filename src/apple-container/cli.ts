/**
 * Argv-only adapter for the Apple `container` CLI.
 *
 * Invariants this module exists to hold:
 *
 * - **No shell, ever.** Commands are always `(binary, argv[])`; no string
 *   command is ever constructed, so there is nothing for a metacharacter to
 *   escape into.
 * - **Exit status is never invented.** A non-zero exit or a fatal signal is
 *   reported faithfully. `run` returns the status, `runChecked` throws with it
 *   attached, and neither ever substitutes a success-shaped result. This
 *   matters because the agent's exit code is propagated to the caller of `awf`.
 * - **Timeouts are visible.** A killed-on-timeout process is reported with
 *   `timedOut: true` rather than being flattened into an ordinary failure, so a
 *   later layer can tell "the agent failed" apart from "we cut the agent off".
 *
 * The spawn seam is injected so every branch is unit-testable without a Mac and
 * without spawning real processes.
 */

import { constants as osConstants } from 'os';
import execa from 'execa';

/** Default CLI binary; resolved from PATH unless a caller pins an absolute path. */
export const APPLE_CONTAINER_DEFAULT_BINARY = 'container';

/** Exit code reported when a process died without an exit code or a signal. */
export const APPLE_CONTAINER_UNKNOWN_EXIT_CODE = -1;

export interface AppleContainerSpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly killSignal?: NodeJS.Signals;
  /**
   * When true the child inherits the parent's stdio, which is what foreground
   * agent execution needs. Captured `stdout`/`stderr` are then empty by
   * definition, and callers must not treat that emptiness as "no output".
   */
  readonly inheritStdio?: boolean;
  /** Only meaningful when `inheritStdio` is false. */
  readonly stdin?: 'ignore' | 'pipe';
}

/** Normalised spawn outcome; the only shape the adapter consumes. */
export interface AppleContainerSpawnResult {
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type AppleContainerSpawn = (
  binary: string,
  args: readonly string[],
  options: AppleContainerSpawnOptions,
) => Promise<AppleContainerSpawnResult>;

export interface AppleContainerCliResult {
  /** Full argv including the binary, for logging and test assertions. */
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Raised by {@link AppleContainerCli.runChecked} for any non-zero exit. */
export class AppleContainerCliError extends Error {
  constructor(
    message: string,
    readonly result: AppleContainerCliResult,
  ) {
    super(message);
    this.name = 'AppleContainerCliError';
  }

  get exitCode(): number {
    return this.result.exitCode;
  }

  get timedOut(): boolean {
    return this.result.timedOut;
  }
}

export interface AppleContainerCliOptions {
  readonly binary?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Applied to every invocation unless overridden per call. */
  readonly timeoutMs?: number;
  readonly killSignal?: NodeJS.Signals;
  readonly spawn?: AppleContainerSpawn;
}

/**
 * Translates a fatal signal into the shell's `128 + signum` convention.
 *
 * Falls back to {@link APPLE_CONTAINER_UNKNOWN_EXIT_CODE} for an unrecognised
 * signal name rather than to 0, so an unknown death can never be mistaken for
 * success.
 */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  const signals = osConstants.signals as unknown as Record<string, number | undefined>;
  const signalNumber = Object.prototype.hasOwnProperty.call(signals, signal)
    ? signals[signal]
    : undefined;
  return typeof signalNumber === 'number' ? 128 + signalNumber : APPLE_CONTAINER_UNKNOWN_EXIT_CODE;
}

/**
 * Normalises a spawn outcome into a definite exit code.
 *
 * Order matters: an explicit numeric exit code always wins, because a process
 * that exited normally after being sent a non-fatal signal still has a real
 * status. Only when there is no exit code does the signal decide.
 */
export function normalizeExitCode(result: AppleContainerSpawnResult): number {
  if (typeof result.exitCode === 'number') {
    return result.exitCode;
  }
  if (result.signal) {
    return exitCodeForSignal(result.signal);
  }
  return APPLE_CONTAINER_UNKNOWN_EXIT_CODE;
}

const defaultSpawn: AppleContainerSpawn = async (binary, args, options) => {
  const stdio: execa.Options['stdio'] = options.inheritStdio
    ? 'inherit'
    : [options.stdin ?? 'ignore', 'pipe', 'pipe'];
  // `binary` is the operator-configured `container` CLI path, never user
  // command text, and every argument is a separate argv element with no shell.
  // eslint-disable-next-line local/no-unsafe-execa
  const result = await execa(binary, [...args], {
    reject: false,
    cwd: options.cwd,
    env: options.env ? { ...options.env } : undefined,
    extendEnv: options.env === undefined,
    timeout: options.timeoutMs ?? 0,
    killSignal: options.killSignal ?? 'SIGTERM',
    stdio,
    windowsHide: true,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal as NodeJS.Signals | undefined,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.timedOut === true,
  };
};

/** @internal Exposed so adapter tests can assert the real execa options. */
export const appleContainerCliTestHelpers = { defaultSpawn };

/**
 * Stateless invoker for the `container` CLI.
 *
 * Holds no lifecycle state of its own; see `./lifecycle.ts` for the operations
 * built on top of it.
 */
export class AppleContainerCli {
  readonly binary: string;

  private readonly spawn: AppleContainerSpawn;

  constructor(private readonly options: AppleContainerCliOptions = {}) {
    this.binary = options.binary ?? APPLE_CONTAINER_DEFAULT_BINARY;
    this.spawn = options.spawn ?? defaultSpawn;
  }

  /** Runs the CLI and reports the outcome without throwing on failure. */
  async run(
    args: readonly string[],
    overrides: AppleContainerSpawnOptions = {},
  ): Promise<AppleContainerCliResult> {
    const spawnOptions: AppleContainerSpawnOptions = {
      cwd: overrides.cwd ?? this.options.cwd,
      env: overrides.env ?? this.options.env,
      timeoutMs: overrides.timeoutMs ?? this.options.timeoutMs,
      killSignal: overrides.killSignal ?? this.options.killSignal,
      inheritStdio: overrides.inheritStdio,
      stdin: overrides.stdin,
    };
    const raw = await this.spawn(this.binary, args, spawnOptions);
    return {
      argv: [this.binary, ...args],
      exitCode: normalizeExitCode(raw),
      signal: raw.signal ?? null,
      stdout: raw.stdout ?? '',
      stderr: raw.stderr ?? '',
      timedOut: raw.timedOut === true,
    };
  }

  /**
   * Runs the CLI and throws an {@link AppleContainerCliError} unless it exited
   * 0. Use this for control-plane operations whose failure must abort the run;
   * use {@link run} where the child's exit code is itself the answer.
   */
  async runChecked(
    args: readonly string[],
    overrides: AppleContainerSpawnOptions = {},
  ): Promise<AppleContainerCliResult> {
    const result = await this.run(args, overrides);
    if (result.exitCode !== 0) {
      throw new AppleContainerCliError(describeFailure(result), result);
    }
    return result;
  }
}

function describeFailure(result: AppleContainerCliResult): string {
  const command = redactDiagnosticArgv(result.argv).join(' ');
  const cause = result.timedOut
    ? 'timed out'
    : result.signal
      ? `was terminated by ${result.signal}`
      : `exited with code ${result.exitCode}`;
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `"${command}" ${cause}: ${detail}` : `"${command}" ${cause}`;
}

function redactDiagnosticArgv(argv: readonly string[]): string[] {
  return argv.map((value, index) => {
    if (index > 0 && argv[index - 1] === '--env') {
      const separator = value.indexOf('=');
      return separator >= 0 ? `${value.slice(0, separator)}=<redacted>` : '<redacted>';
    }
    return value;
  });
}
