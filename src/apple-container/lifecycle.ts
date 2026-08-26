/**
 * Apple Container lifecycle primitives.
 *
 * A thin, typed layer over `./cli.ts` covering exactly the operations later
 * backend layers need. It owns no policy and holds no state: callers pass IDs
 * and specs, and every returned value is either a validated primitive or a
 * faithful {@link AppleContainerCliResult}.
 *
 * Failure handling is deliberately asymmetric:
 *
 * - Control-plane operations (pull, create, stop, kill, delete, inspect, list)
 *   use `runChecked` and throw, because a silent failure here would leave the
 *   caller reasoning about a container that does not exist.
 * - {@link AppleContainerLifecycle.runForeground} and
 *   {@link AppleContainerLifecycle.startAttached} use `run`, because the child's
 *   exit code *is* the result and must be propagated verbatim — including a
 *   non-zero one.
 *
 * Nothing in this file catches broadly or falls back to a success-shaped value.
 */

import {
  AppleContainerCli,
  type AppleContainerCliOptions,
  type AppleContainerCliResult,
  type AppleContainerSpawnOptions,
} from './cli';
import {
  buildAppleContainerRunArgs,
  type AppleContainerRunSpec,
} from './run-args';
import {
  assertAppleContainerId,
  assertAppleContainerImageReference,
  assertAppleContainerSignal,
  assertAppleContainerStopTimeout,
} from './validation';

/** Parsed `container --version` output. */
export interface AppleContainerVersion {
  /** Semantic version, e.g. `"0.4.1"`. */
  readonly version: string;
  /** Full raw line, retained for diagnostics. */
  readonly raw: string;
}

export interface AppleContainerSystemStatus {
  readonly healthy: boolean;
  readonly result: AppleContainerCliResult;
}

export interface AppleContainerPullOptions {
  readonly os?: string;
  readonly arch?: string;
  /** `os/arch[/variant]`; takes precedence over `os`/`arch` in the CLI. */
  readonly platform?: string;
}

export interface AppleContainerStopOptions {
  readonly signal?: string;
  /** Seconds to wait before the CLI escalates to a kill (CLI default is 5). */
  readonly timeoutSeconds?: number;
}

export interface AppleContainerStartAttachedOptions extends AppleContainerSpawnOptions {
  /**
   * Also attach stdin (`--interactive`). Off by default: a CI job has no
   * usable stdin, and attaching it there is a behaviour change, not a no-op.
   */
  readonly interactive?: boolean;
}

/**
 * Raised when `container --version` ran successfully but printed something this
 * adapter cannot parse.
 *
 * Distinct from a CLI that could not be run at all, so preflight can report an
 * installed-but-unrecognised CLI as a version problem rather than telling the
 * operator to install a CLI they already have.
 */
export class AppleContainerVersionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleContainerVersionParseError';
  }
}

/**
 * Parses `container CLI version 0.4.1 (build: release, commit: abcdef1)`.
 *
 * Throws on anything unparseable so a version gate can never be satisfied by
 * output we do not understand.
 */
export function parseAppleContainerVersion(output: string): AppleContainerVersion {
  const raw = output.trim();
  const match =
    /^(?:container CLI version\s+v?(\d+\.\d+(?:\.\d+)?)|v?(\d+\.\d+(?:\.\d+)?))(?=$|\s|\()/.exec(raw);
  if (!match) {
    throw new AppleContainerVersionParseError(
      `Could not parse Apple Container CLI version from: ${JSON.stringify(output)}`,
    );
  }
  return { version: match[1] ?? match[2], raw };
}

/**
 * Parses the container ID printed by `container create`.
 *
 * The CLI prints progress to stderr and the bare ID on stdout, but the last
 * non-empty stdout line is used rather than the whole buffer so a future
 * progress line cannot corrupt the ID. The result is validated against Apple
 * Container's own ID predicate.
 */
export function parseCreatedContainerId(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const candidate = lines[lines.length - 1];
  if (candidate === undefined) {
    throw new Error('Apple Container "create" did not print a container ID');
  }
  return assertAppleContainerId(candidate, 'created container ID');
}

/** Parses `--format json` output, failing loudly rather than returning a default. */
export function parseAppleContainerJson(label: string, stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`Apple Container "${label}" returned no JSON output`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `Apple Container "${label}" returned unparseable JSON: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function platformArgs(options: AppleContainerPullOptions): string[] {
  const args: string[] = [];
  if (options.platform !== undefined) {
    args.push('--platform', assertPlatformToken(options.platform));
    return args;
  }
  if (options.os !== undefined) args.push('--os', assertPlatformComponent(options.os, 'OS'));
  if (options.arch !== undefined) {
    args.push('--arch', assertPlatformComponent(options.arch, 'architecture'));
  }
  return args;
}

function assertPlatformComponent(value: string, label: string): string {
  if (!/^[a-z0-9]+$/.test(value)) {
    throw new Error(`Apple Container platform ${label} must be lowercase alphanumeric; got ${value}`);
  }
  return value;
}

function assertPlatformToken(value: string): string {
  if (!/^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?$/.test(value)) {
    throw new Error(`Apple Container platform must be "os/arch[/variant]"; got ${value}`);
  }
  return value;
}

/** Typed lifecycle operations over a single {@link AppleContainerCli}. */
export class AppleContainerLifecycle {
  readonly cli: AppleContainerCli;

  constructor(cli: AppleContainerCli | AppleContainerCliOptions = {}) {
    this.cli = cli instanceof AppleContainerCli ? cli : new AppleContainerCli(cli);
  }

  async version(): Promise<AppleContainerVersion> {
    const result = await this.cli.runChecked(['--version']);
    // Some builds print the banner on stderr; prefer stdout but accept either.
    return parseAppleContainerVersion(result.stdout.trim() || result.stderr);
  }

  /**
   * Queries the `container` service.
   *
   * A non-zero exit means "not registered" or "not running" and is a normal,
   * expected answer rather than an adapter failure, so this reports rather than
   * throws and lets preflight decide.
   */
  async systemStatus(): Promise<AppleContainerSystemStatus> {
    const result = await this.cli.run(['system', 'status', '--format', 'json']);
    return { healthy: result.exitCode === 0, result };
  }

  async pullImage(
    reference: string,
    options: AppleContainerPullOptions = {},
  ): Promise<AppleContainerCliResult> {
    return this.cli.runChecked([
      'image',
      'pull',
      ...platformArgs(options),
      assertAppleContainerImageReference(reference),
    ]);
  }

  /** Creates a container without starting it and returns its validated ID. */
  async create(spec: AppleContainerRunSpec): Promise<string> {
    const result = await this.cli.runChecked(buildAppleContainerRunArgs(spec, 'create'));
    return parseCreatedContainerId(result.stdout);
  }

  /** Starts a previously created container without attaching to it. */
  async start(id: string): Promise<AppleContainerCliResult> {
    return this.cli.runChecked(['start', assertAppleContainerId(id)]);
  }

  /**
   * Starts a created container attached to this process's stdio and resolves
   * with the container's own exit status. Does not throw on non-zero.
   *
   * stdin is *not* attached unless `interactive` is set: CI has no stdin, and
   * attaching it there causes the container's init to see an immediate EOF.
   */
  async startAttached(
    id: string,
    options: AppleContainerStartAttachedOptions = {},
  ): Promise<AppleContainerCliResult> {
    const { interactive, ...overrides } = options;
    const args = ['start', '--attach'];
    if (interactive) {
      args.push('--interactive');
    }
    args.push(assertAppleContainerId(id));
    return this.cli.run(args, { inheritStdio: true, ...overrides });
  }

  /**
   * Runs a container in the foreground and resolves with its exit status.
   *
   * The exit code is propagated verbatim, so callers must inspect it; a
   * non-zero result is a successful *invocation* that reports failure.
   */
  async runForeground(
    spec: AppleContainerRunSpec,
    overrides: AppleContainerSpawnOptions = {},
  ): Promise<AppleContainerCliResult> {
    return this.cli.run(buildAppleContainerRunArgs(spec, 'run'), {
      inheritStdio: true,
      ...overrides,
    });
  }

  async stop(
    id: string,
    options: AppleContainerStopOptions = {},
  ): Promise<AppleContainerCliResult> {
    const args = ['stop'];
    if (options.signal !== undefined) {
      args.push('--signal', assertAppleContainerSignal(options.signal));
    }
    if (options.timeoutSeconds !== undefined) {
      args.push('--time', String(assertAppleContainerStopTimeout(options.timeoutSeconds)));
    }
    args.push(assertAppleContainerId(id));
    return this.cli.runChecked(args);
  }

  async kill(id: string, signal = 'KILL'): Promise<AppleContainerCliResult> {
    return this.cli.runChecked([
      'kill',
      '--signal',
      assertAppleContainerSignal(signal),
      assertAppleContainerId(id),
    ]);
  }

  async remove(id: string, options: { force?: boolean } = {}): Promise<AppleContainerCliResult> {
    const args = ['delete'];
    if (options.force) args.push('--force');
    args.push(assertAppleContainerId(id));
    return this.cli.runChecked(args);
  }

  /** `container inspect` always emits pretty JSON; it has no `--format` flag. */
  async inspect(id: string): Promise<unknown> {
    const result = await this.cli.runChecked(['inspect', assertAppleContainerId(id)]);
    return parseAppleContainerJson('inspect', result.stdout);
  }

  async list(options: { all?: boolean } = {}): Promise<unknown> {
    const args = ['list'];
    if (options.all) args.push('--all');
    args.push('--format', 'json');
    const result = await this.cli.runChecked(args);
    return parseAppleContainerJson('list', result.stdout);
  }
}
