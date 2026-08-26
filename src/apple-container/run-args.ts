/**
 * Typed model for `container run` / `container create` and its argv builder.
 *
 * This layer models the flags that later backend layers will need, but
 * deliberately implements **no policy**: it does not decide what the agent's
 * mounts, memory, or network should be, only how a validated decision is turned
 * into argv. Policy lands in a later layer of the stack.
 *
 * Two defaults are load-bearing and must not be relaxed:
 *
 * 1. **`--network none`.** Apple Container attaches the *default* vmnet network
 *    when `--network` is omitted; `none` is a reserved sentinel that produces no
 *    NIC at all. Omitting the flag would therefore silently give the agent
 *    unfiltered egress, so `network` defaults to `{ kind: 'none' }` and the
 *    flag is always emitted explicitly.
 * 2. **No implicit capabilities.** `capAdd` defaults to empty. Nothing here
 *    ever adds a capability the caller did not ask for.
 *
 * Flag emission order is fixed so callers, tests, and log output all see a
 * stable, diffable argv.
 */

import {
  assertAppleContainerCapability,
  assertAppleContainerCpuCount,
  assertAppleContainerEnvName,
  assertAppleContainerEnvValue,
  assertAppleContainerId,
  assertAppleContainerImageReference,
  assertAppleContainerLabelName,
  assertAppleContainerLabelValue,
  assertAppleContainerMemorySize,
  assertAppleContainerNetworkName,
  assertAppleContainerPath,
} from './validation';

/** Reserved `--network` value meaning "no network interface at all". */
export const APPLE_CONTAINER_NO_NETWORK = 'none';

/** Default guest architecture: native arm64, never Rosetta-translated amd64. */
export const APPLE_CONTAINER_DEFAULT_ARCH = 'arm64';

export const APPLE_CONTAINER_DEFAULT_OS = 'linux';

/**
 * `--mount` packs fields into one comma-separated `key=value` token, so both
 * `,` and `=` inside a path would create or overwrite sibling fields.
 */
const MOUNT_PATH_DELIMITERS = [',', '='] as const;

/** `--publish-socket` is `host_path:container_path`. */
const SOCKET_PATH_DELIMITERS = [':'] as const;

/**
 * A host directory or file bind-mounted into the guest.
 *
 * `readOnly` has no default here on purpose: the caller must state the
 * intent, and {@link buildAppleContainerRunArgs} treats `undefined` as
 * read-write only because that is what Apple Container itself does.
 */
export interface AppleContainerBindMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

/**
 * A host Unix socket published into the guest via `--publish-socket`.
 *
 * This is the mechanism a later layer uses to reach AWF infrastructure without
 * giving the guest a NIC, which is why it is modelled now.
 */
export interface AppleContainerSocketMount {
  readonly hostPath: string;
  readonly containerPath: string;
}

/**
 * Network attachment policy.
 *
 * `attach` is intentionally awkward to reach: a caller has to name the networks
 * explicitly, and `none` may not be mixed in (Apple Container rejects that
 * combination too).
 */
export type AppleContainerNetworkPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'attach'; readonly networks: readonly string[] };

export interface AppleContainerRunSpec {
  readonly image: string;
  /**
   * Arguments for the container's init process. Apple Container declares these
   * with `.captureForPassthrough`, so leading dashes are safe and are *not*
   * rewritten or prefixed with `--`.
   */
  readonly args?: readonly string[];
  readonly name?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly cpus?: number;
  /** Integer with an optional K/M/G/T/P suffix, e.g. `"8G"`. */
  readonly memory?: string;
  readonly workdir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly user?: string;
  readonly entrypoint?: string;
  /** Mounts the guest root filesystem read-only (`--read-only`). */
  readonly readOnlyRootfs?: boolean;
  /** Additional guest paths marked read-only (`--read-only-path`, experimental). */
  readonly readOnlyPaths?: readonly string[];
  readonly capDrop?: readonly string[];
  readonly capAdd?: readonly string[];
  readonly mounts?: readonly AppleContainerBindMount[];
  readonly socketMounts?: readonly AppleContainerSocketMount[];
  /** Defaults to `{ kind: 'none' }`; see the module comment. */
  readonly network?: AppleContainerNetworkPolicy;
  /** Custom init filesystem image (`--init-image`). */
  readonly initImage?: string;
  /** Run a lightweight init as PID 1 (`--init`). */
  readonly useInit?: boolean;
  /** Keep stdin open (`--interactive`). */
  readonly interactive?: boolean;
  /**
   * Allocate a PTY (`--tty`). Defaults to false: CI has no controlling
   * terminal, and requesting one there corrupts captured output.
   */
  readonly tty?: boolean;
  readonly detach?: boolean;
  readonly removeOnExit?: boolean;
  /** Writes the container ID to this host path (`--cidfile`). */
  readonly cidFile?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export type AppleContainerRunMode = 'run' | 'create';

function buildMountToken(mount: AppleContainerBindMount): string {
  const source = assertAppleContainerPath(mount.source, 'mount source', MOUNT_PATH_DELIMITERS);
  const target = assertAppleContainerPath(mount.target, 'mount target', MOUNT_PATH_DELIMITERS);
  const token = `type=bind,source=${source},target=${target}`;
  return mount.readOnly ? `${token},readonly` : token;
}

function buildSocketToken(socket: AppleContainerSocketMount): string {
  const hostPath = assertAppleContainerPath(
    socket.hostPath,
    'published socket host path',
    SOCKET_PATH_DELIMITERS,
  );
  const containerPath = assertAppleContainerPath(
    socket.containerPath,
    'published socket container path',
    SOCKET_PATH_DELIMITERS,
  );
  return `${hostPath}:${containerPath}`;
}

function buildNetworkArgs(policy: AppleContainerNetworkPolicy): string[] {
  if (policy.kind === 'none') {
    return ['--network', APPLE_CONTAINER_NO_NETWORK];
  }
  if (policy.networks.length === 0) {
    throw new Error(
      'Apple Container network policy "attach" requires at least one network name; use ' +
      '{ kind: "none" } for an isolated container',
    );
  }
  const args: string[] = [];
  for (const network of policy.networks) {
    if (network === APPLE_CONTAINER_NO_NETWORK) {
      throw new Error(
        `Apple Container network "${APPLE_CONTAINER_NO_NETWORK}" cannot be combined with other ` +
        'networks; use { kind: "none" } instead',
      );
    }
    args.push('--network', assertAppleContainerNetworkName(network));
  }
  return args;
}

/**
 * Builds the full argv for `container run` or `container create`.
 *
 * The returned array starts at the subcommand (`['run', …]`) and does not
 * include the `container` binary itself, which the CLI adapter owns.
 */
export function buildAppleContainerRunArgs(
  spec: AppleContainerRunSpec,
  mode: AppleContainerRunMode = 'run',
): string[] {
  const args: string[] = [mode];

  if (spec.name !== undefined) {
    args.push('--name', assertAppleContainerId(spec.name, 'container name'));
  }

  args.push('--os', spec.os ?? APPLE_CONTAINER_DEFAULT_OS);
  args.push('--arch', spec.arch ?? APPLE_CONTAINER_DEFAULT_ARCH);

  if (spec.cpus !== undefined) {
    args.push('--cpus', String(assertAppleContainerCpuCount(spec.cpus)));
  }
  if (spec.memory !== undefined) {
    args.push('--memory', assertAppleContainerMemorySize(spec.memory));
  }
  if (spec.workdir !== undefined) {
    args.push('--workdir', assertAppleContainerPath(spec.workdir, 'workdir', []));
  }
  if (spec.user !== undefined) {
    args.push('--user', assertUserSpec(spec.user));
  }
  if (spec.entrypoint !== undefined) {
    args.push('--entrypoint', spec.entrypoint);
  }

  for (const [name, value] of Object.entries(spec.env ?? {})) {
    assertAppleContainerEnvName(name);
    assertAppleContainerEnvValue(name, value);
    args.push('--env', `${name}=${value}`);
  }

  for (const [name, value] of Object.entries(spec.labels ?? {})) {
    assertAppleContainerLabelName(name);
    assertAppleContainerLabelValue(name, value);
    args.push('--label', `${name}=${value}`);
  }

  if (spec.readOnlyRootfs) {
    args.push('--read-only');
  }
  for (const readOnlyPath of spec.readOnlyPaths ?? []) {
    args.push('--read-only-path', assertAppleContainerPath(readOnlyPath, 'read-only path', []));
  }

  for (const capability of spec.capDrop ?? []) {
    args.push('--cap-drop', assertAppleContainerCapability(capability));
  }
  for (const capability of spec.capAdd ?? []) {
    args.push('--cap-add', assertAppleContainerCapability(capability));
  }

  for (const mount of spec.mounts ?? []) {
    args.push('--mount', buildMountToken(mount));
  }
  for (const socket of spec.socketMounts ?? []) {
    args.push('--publish-socket', buildSocketToken(socket));
  }

  args.push(...buildNetworkArgs(spec.network ?? { kind: 'none' }));

  if (spec.initImage !== undefined) {
    args.push('--init-image', assertAppleContainerImageReference(spec.initImage));
  }
  if (spec.useInit) {
    args.push('--init');
  }
  if (spec.cidFile !== undefined) {
    args.push('--cidfile', assertAppleContainerPath(spec.cidFile, 'cidfile path', []));
  }
  if (spec.interactive) {
    args.push('--interactive');
  }
  if (spec.tty) {
    args.push('--tty');
  }
  if (spec.detach) {
    args.push('--detach');
  }
  if (spec.removeOnExit) {
    args.push('--rm');
  }

  // The image must be the first positional; everything after it is captured
  // for passthrough by Apple Container and is never reinterpreted as a flag.
  args.push(assertAppleContainerImageReference(spec.image));
  args.push(...(spec.args ?? []));

  return args;
}

/** `--user` accepts `name|uid[:gid]`; reject anything that could split the token. */
function assertUserSpec(value: string): string {
  if (!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(value)) {
    throw new Error(`Apple Container user spec must be "name|uid[:gid]"; got ${value}`);
  }
  return value;
}
