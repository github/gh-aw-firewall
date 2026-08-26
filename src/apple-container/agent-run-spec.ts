/**
 * Builds the Apple Container agent run spec: what the guest can see, who it
 * runs as, and what it is told about its endpoints.
 *
 * Everything here is *policy*; layer 1 turns the result into argv and layer 2
 * merges in the capability transport. The three concerns this module owns:
 *
 * **Filesystem.** Apple Container is not the Docker topology: there is no
 * chroot at `/host`, no sysroot, no `/etc` cherry-picking, and no Docker socket.
 * The guest runs the agent image's own root filesystem read-only and receives a
 * short, explicit list of writable host directories — the workspace, the
 * `gh-aw` state directory when one exists, and two run-scoped directories AWF
 * creates for `/tmp` and `$HOME`. Nothing else is mounted, so host credentials
 * (`~/.ssh`, `~/.aws`, `~/.docker`, the login keychain) are absent by
 * construction rather than by exclusion. That is deliberately unlike the Docker
 * path's credential-hiding overlays, which have to temporarily shadow live host
 * files; there is nothing to shadow when the mount was never made.
 *
 * **Identity.** The workload runs as the host uid:gid so files it writes into
 * the workspace are owned by the runner user, and `$HOME` points at a
 * run-scoped directory that same uid owns.
 *
 * **Environment.** The guest's endpoints are all `127.0.0.1`, served by the
 * layer-2 guest relay. Reusing AWF's own environment builders with a loopback
 * "network" yields exactly the endpoints the transport plan publishes, so the
 * plan's conflict check passes on identical values rather than being bypassed.
 * Real provider credentials never appear: they stay in the host-side API proxy
 * sidecar, and {@link buildAppleContainerGuestEnvironment} re-asserts that
 * before the values can reach argv.
 */

import * as path from 'path';

import { NETWORK_SUBNET } from '../config/network-policy';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { resolveLogPaths } from '../log-paths';
import { buildGuestEnvironment } from '../microvm/guest-environment';
import type { WrapperConfig } from '../types';
import { apiProxyPorts } from '../config/network-policy';
import { APPLE_CONTAINER_LOOPBACK_HOST } from './infrastructure-endpoints';
import type { AppleContainerBindMount, AppleContainerRunSpec } from './run-args';
import { assertAppleContainerEnvValue } from './validation';

/** Writable `$HOME` for the workload, backed by a run-scoped host directory. */
export const APPLE_CONTAINER_GUEST_HOME = '/awf/home';

/** Writable `/tmp`, backed by a run-scoped host directory. */
export const APPLE_CONTAINER_GUEST_TMP = '/tmp';

/** Guest working directory when the config does not name one. */
export const APPLE_CONTAINER_DEFAULT_WORKDIR = '/workspace';

/**
 * Entrypoint override.
 *
 * The agent image's own entrypoint is Docker-specific end to end: it waits on
 * the `awf-iptables-init` ready file, remaps `awfuser`, rewrites
 * `/etc/resolv.conf`, chroots into `/host`, and drops `SYS_CHROOT`/`SYS_ADMIN`.
 * None of that exists — or is needed — in a VM whose isolation is the VM. It is
 * bypassed rather than adapted so no half-applicable Docker assumption runs.
 */
export const APPLE_CONTAINER_ENTRYPOINT = '/bin/bash';

/** Host-side run-scoped directories the backend creates before launch. */
export interface AppleContainerRunDirectories {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  /** Mountpoint for the agent log directory, inside {@link home}. */
  readonly homeCopilotLogs: string;
  /** Mountpoint for the agent session-state directory, inside {@link home}. */
  readonly homeCopilotSessionState: string;
}

/**
 * Derives the run-scoped host directory layout.
 *
 * The `.copilot` mountpoints live inside the guest home directory because the
 * agent CLI writes there unconditionally. They are created on the host so the
 * nested virtiofs mounts have a real mountpoint to land on; a missing
 * mountpoint inside a virtiofs share is a boot-time failure, not a fallback.
 */
export function appleContainerRunDirectories(workDir: string): AppleContainerRunDirectories {
  const root = path.join(workDir, 'apple-container');
  const home = path.join(root, 'home');
  return {
    root,
    home,
    tmp: path.join(root, 'tmp'),
    homeCopilotLogs: path.join(home, '.copilot', 'logs'),
    homeCopilotSessionState: path.join(home, '.copilot', 'session-state'),
  };
}

export interface AppleContainerMountPlanInput {
  readonly config: WrapperConfig;
  readonly directories: AppleContainerRunDirectories;
  readonly workspaceDir: string;
  /** `${RUNNER_TEMP}/gh-aw`, when the runner created one. */
  readonly ghAwStateDir?: string;
}

/**
 * Builds the complete bind-mount list.
 *
 * Host paths are mounted at their *own* absolute path wherever the workload may
 * see that path in its arguments or environment (the workspace, the `gh-aw`
 * state directory), because gh-aw passes absolute runner paths through both.
 */
export function buildAppleContainerMounts(
  input: AppleContainerMountPlanInput,
): readonly AppleContainerBindMount[] {
  const { config, directories, workspaceDir, ghAwStateDir } = input;
  const logPaths = resolveLogPaths(config);

  const mounts: AppleContainerBindMount[] = [
    { source: directories.tmp, target: APPLE_CONTAINER_GUEST_TMP, readOnly: false },
    { source: directories.home, target: APPLE_CONTAINER_GUEST_HOME, readOnly: false },
    { source: workspaceDir, target: workspaceDir, readOnly: false },
    {
      source: logPaths.agentLogs,
      target: `${APPLE_CONTAINER_GUEST_HOME}/.copilot/logs`,
      readOnly: false,
    },
    {
      source: logPaths.sessionState,
      target: `${APPLE_CONTAINER_GUEST_HOME}/.copilot/session-state`,
      readOnly: false,
    },
  ];

  // Safe outputs and tool state. Mounted at the identical host path so the
  // absolute paths gh-aw injects (GH_AW_SAFE_OUTPUTS and friends) resolve.
  if (ghAwStateDir && ghAwStateDir !== workspaceDir && !isWithin(ghAwStateDir, workspaceDir)) {
    mounts.push({ source: ghAwStateDir, target: ghAwStateDir, readOnly: false });
  }

  return Object.freeze(mounts.map((mount) => Object.freeze(mount)));
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface AppleContainerGuestEnvironmentInput {
  readonly config: WrapperConfig;
  readonly workspaceDir: string;
}

/**
 * Environment variables the transport plan owns.
 *
 * `applyAppleContainerTransportToRunSpec` refuses a spec that sets any of these
 * to a *different* value, which is the correct behaviour — it means nothing can
 * quietly repoint the workload at a non-transport endpoint. `NO_PROXY` is the
 * one AWF's builder legitimately computes differently (it lists Docker service
 * names the guest cannot resolve), so it is dropped here and the plan's value
 * is used instead of being fought over.
 */
const TRANSPORT_OWNED_ENV = ['NO_PROXY', 'no_proxy'] as const;

/**
 * Environment variables that describe the Docker topology and mean nothing —
 * or something misleading — inside a NIC-less VM.
 */
const DOCKER_TOPOLOGY_ENV = [
  // The iptables-init handshake directory does not exist; leaving it set would
  // make a future guest-side check wait on a file that is never written.
  'AWF_INIT_SIGNAL_DIR',
] as const;

/**
 * Builds the guest environment.
 *
 * @throws when a value cannot be represented as a single `--env KEY=VALUE` argv
 * token, or when a real provider credential would cross the VM boundary.
 */
export function buildAppleContainerGuestEnvironment(
  input: AppleContainerGuestEnvironmentInput,
): Record<string, string> {
  const { config, workspaceDir } = input;

  const environment = buildGuestEnvironment({
    config,
    networkConfig: {
      subnet: NETWORK_SUBNET,
      // Every endpoint is loopback inside the guest: the layer-2 relay listens
      // on 127.0.0.1 at the same port the sidecar uses on the host, so AWF's
      // own builders produce transport-identical URLs.
      squidIp: APPLE_CONTAINER_LOOPBACK_HOST,
      agentIp: APPLE_CONTAINER_LOOPBACK_HOST,
      ...(config.enableApiProxy ? { proxyIp: APPLE_CONTAINER_LOOPBACK_HOST } : {}),
      ...(config.difcProxyHost ? { cliProxyIp: APPLE_CONTAINER_LOOPBACK_HOST } : {}),
    },
    home: APPLE_CONTAINER_GUEST_HOME,
    workspace: workspaceDir,
    runtimeName: 'apple-container',
    runtimeDisplayName: 'Apple Container',
  });

  for (const name of [...TRANSPORT_OWNED_ENV, ...DOCKER_TOPOLOGY_ENV]) {
    delete environment[name];
  }

  // Caches and config default to `$HOME`, which is the run-scoped writable
  // mount. Without these, tools fall back to paths on the read-only rootfs.
  environment.XDG_CACHE_HOME = `${APPLE_CONTAINER_GUEST_HOME}/.cache`;
  environment.XDG_CONFIG_HOME = `${APPLE_CONTAINER_GUEST_HOME}/.config`;
  environment.XDG_DATA_HOME = `${APPLE_CONTAINER_GUEST_HOME}/.local/share`;
  environment.TMPDIR = APPLE_CONTAINER_GUEST_TMP;

  assertVertexEndpointAbsent(environment);
  assertArgvRepresentable(environment);
  return environment;
}

/**
 * The Vertex provider port is not in the capability allowlist, so an endpoint
 * pointing at it would be a black hole inside the guest. `runtime-validation`
 * rejects a Vertex configuration up front; this is the defence in depth that
 * makes a future regression in that guard fail loudly here instead of silently
 * producing a dead endpoint.
 */
function assertVertexEndpointAbsent(environment: Readonly<Record<string, string>>): void {
  const vertexEndpoint = `:${apiProxyPorts().vertex}`;
  for (const [name, value] of Object.entries(environment)) {
    if (value.includes(APPLE_CONTAINER_LOOPBACK_HOST) && value.includes(vertexEndpoint)) {
      throw new Error(
        `Apple Container guest variable ${name} points at the Vertex API proxy port, which the ` +
        'capability transport does not bridge; remove the Vertex configuration',
      );
    }
  }
}

/**
 * Fails closed on values that cannot survive argv.
 *
 * `--env` is a single token, so a newline or NUL would either be rejected by
 * the CLI or silently truncate. Dropping the variable instead would hand the
 * workload a subtly different environment than the operator configured, so the
 * run is refused with the offending names named.
 */
function assertArgvRepresentable(environment: Readonly<Record<string, string>>): void {
  const invalid: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    try {
      assertAppleContainerEnvValue(name, value);
    } catch {
      invalid.push(name);
    }
  }
  if (invalid.length > 0) {
    throw new Error(
      `Apple Container cannot pass ${invalid.length} environment variable(s) containing NUL or ` +
      `newlines through "container run --env": ${invalid.join(', ')}. ` +
      'Remove them with --exclude-env or set a single-line value.',
    );
  }
}

export interface AppleContainerAgentSpecInput {
  readonly config: WrapperConfig;
  readonly directories: AppleContainerRunDirectories;
  readonly workspaceDir: string;
  readonly ghAwStateDir?: string;
  readonly image: string;
  readonly name: string;
  readonly cpus: number;
  readonly memory: string;
  readonly identity?: { readonly uid: string; readonly gid: string };
}

/**
 * Assembles the layer-1 run spec for the agent.
 *
 * The transport plan is merged in afterwards by `transport.applyTo(spec)`, which
 * adds the published sockets, endpoint environment, cap drops, and init image,
 * and re-asserts `--network none`. Nothing here sets a network or a capability,
 * so the merge has nothing to fight with.
 */
export function buildAppleContainerAgentSpec(
  input: AppleContainerAgentSpecInput,
): AppleContainerRunSpec {
  const { config, directories, workspaceDir, ghAwStateDir, image, name, cpus, memory } = input;
  const identity = input.identity ?? { uid: getSafeHostUid(), gid: getSafeHostGid() };

  return {
    image,
    name,
    cpus,
    memory,
    user: `${identity.uid}:${identity.gid}`,
    workdir: config.containerWorkDir || workspaceDir || APPLE_CONTAINER_DEFAULT_WORKDIR,
    entrypoint: APPLE_CONTAINER_ENTRYPOINT,
    // `-l` gives the workload the image's login profile (PATH additions for
    // node, gh, and the agent CLIs), matching what the Docker entrypoint's
    // `bash -lc` invocation provides.
    args: ['-lc', config.agentCommand],
    env: buildAppleContainerGuestEnvironment({ config, workspaceDir }),
    mounts: buildAppleContainerMounts({ config, directories, workspaceDir, ghAwStateDir }),
    readOnlyRootfs: true,
    // No TTY: `runtime-validation` rejects `--tty`, and requesting a PTY in CI
    // corrupts captured output.
    tty: false,
    // stdin is attached so an interactive agent CLI reading from stdin behaves
    // as it does under Docker; a closed stdin yields immediate EOF either way.
    interactive: true,
    removeOnExit: false,
  };
}
