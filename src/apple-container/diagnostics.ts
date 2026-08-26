/**
 * Apple Container diagnostics collection.
 *
 * Apple Container is a VM-per-container runtime, so a failed agent has two
 * distinct log surfaces that a Docker-shaped mental model does not cover:
 * the guest's **boot log** (`container logs --boot`, i.e. kernel + init, which
 * is where a VM that never reached the entrypoint fails) and the host
 * **service log** (`container system logs`, which is where the daemon records
 * why a VM was refused). Both are captured, plus a live inspect/list snapshot.
 *
 * Every capture is bounded (`-n` for container logs, `--last` for system logs)
 * so a runaway guest cannot fill the host disk, and `--follow` is never used
 * because collection must terminate.
 *
 * Collection is best-effort by design: it runs on a path where something has
 * already gone wrong, and a diagnostics failure must never mask or replace the
 * original error. Individual captures therefore record their own failure text
 * instead of propagating, which is the one place in this module area where a
 * broad catch is correct.
 */

import {
  AppleContainerCli,
  type AppleContainerCliOptions,
} from './cli';
import {
  assertAppleContainerId,
  assertAppleContainerLineCount,
  assertAppleContainerLogWindow,
  assertAppleContainerTimeoutMs,
} from './validation';

/** Default number of trailing log lines captured per container log stream. */
export const APPLE_CONTAINER_DEFAULT_LOG_LINES = 2_000;

/** Default `container system logs --last` window. */
export const APPLE_CONTAINER_DEFAULT_LOG_WINDOW = '15m';

/** Timeout for a single diagnostics command; collection must not hang teardown. */
export const APPLE_CONTAINER_DIAGNOSTICS_TIMEOUT_MS = 30_000;

export interface AppleContainerLogOptions {
  /** Trailing line bound; defaults to {@link APPLE_CONTAINER_DEFAULT_LOG_LINES}. */
  readonly lines?: number;
  /** Capture the VM boot log instead of the init process's stdio. */
  readonly boot?: boolean;
}

/** Builds argv for `container logs`. Never emits `--follow`. */
export function buildAppleContainerLogsArgs(
  id: string,
  options: AppleContainerLogOptions = {},
): string[] {
  const args = ['logs'];
  if (options.boot) {
    args.push('--boot');
  }
  // `-n` is short-only on this command; there is no `--tail`/`--lines` alias.
  args.push('-n', String(assertAppleContainerLineCount(options.lines ?? APPLE_CONTAINER_DEFAULT_LOG_LINES)));
  args.push(assertAppleContainerId(id));
  return args;
}

/** Builds argv for `container system logs`. Never emits `--follow`. */
export function buildAppleContainerSystemLogsArgs(
  window: string = APPLE_CONTAINER_DEFAULT_LOG_WINDOW,
): string[] {
  return ['system', 'logs', '--last', assertAppleContainerLogWindow(window)];
}

/** One captured artifact. `ok: false` means the capture failed, not that the run failed. */
export interface AppleContainerDiagnosticCapture {
  readonly name: string;
  readonly argv: readonly string[];
  readonly ok: boolean;
  readonly content: string;
}

export interface AppleContainerDiagnosticsOptions {
  readonly logLines?: number;
  readonly systemLogWindow?: string;
  /** Omit the container-scoped captures when no container was ever created. */
  readonly containerId?: string;
  readonly timeoutMs?: number;
}

export interface AppleContainerDiagnostics {
  readonly captures: readonly AppleContainerDiagnosticCapture[];
}

/**
 * Runs the diagnostics command set and returns every capture, successful or
 * not. Never throws.
 */
export async function collectAppleContainerDiagnostics(
  cli: AppleContainerCli | AppleContainerCliOptions = {},
  options: AppleContainerDiagnosticsOptions = {},
): Promise<AppleContainerDiagnostics> {
  const invoker = cli instanceof AppleContainerCli ? cli : new AppleContainerCli(cli);
  let timeoutMs: number;
  const planned: Array<{ name: string; args: string[] }> = [];
  try {
    timeoutMs = assertAppleContainerTimeoutMs(
      options.timeoutMs ?? APPLE_CONTAINER_DIAGNOSTICS_TIMEOUT_MS,
    );
    planned.push({ name: 'system-status.json', args: ['system', 'status', '--format', 'json'] });
    planned.push({ name: 'containers.json', args: ['list', '--all', '--format', 'json'] });
    planned.push({
      name: 'system.log',
      args: buildAppleContainerSystemLogsArgs(options.systemLogWindow),
    });
    if (options.containerId !== undefined) {
      const id = assertAppleContainerId(options.containerId);
      planned.push({ name: 'container-inspect.json', args: ['inspect', id] });
      planned.push({
        name: 'container-boot.log',
        args: buildAppleContainerLogsArgs(id, { lines: options.logLines, boot: true }),
      });
      planned.push({
        name: 'container-stdio.log',
        args: buildAppleContainerLogsArgs(id, { lines: options.logLines }),
      });
    }
  } catch (error) {
    // A malformed diagnostics request must not mask the failure being
    // diagnosed, so the validation error is itself reported as a capture.
    return {
      captures: [
        {
          name: 'diagnostics-error.txt',
          argv: [],
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const captures: AppleContainerDiagnosticCapture[] = [];
  for (const step of planned) {
    captures.push(await capture(invoker, step.name, step.args, timeoutMs));
  }
  return { captures };
}

async function capture(
  cli: AppleContainerCli,
  name: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<AppleContainerDiagnosticCapture> {
  try {
    const result = await cli.run(args, { timeoutMs });
    const body = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n');
    return {
      name,
      argv: result.argv,
      ok: result.exitCode === 0,
      content: result.exitCode === 0
        ? body
        : `(exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})\n${body}`,
    };
  } catch (error) {
    return {
      name,
      argv: [cli.binary, ...args],
      ok: false,
      content: `(capture failed) ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
