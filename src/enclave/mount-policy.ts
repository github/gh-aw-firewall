import * as fs from 'fs';
import * as path from 'path';
import { etcAllowlist, HOME_TOOL_SUBDIRS, systemDirectories } from '../config/mount-policy';
import { getRealUserHome } from '../host-identity';
import type { WrapperConfig } from '../types';
import { applyHostPathPrefixToVolumes } from '../services/host-path-prefix';
import { resolveDockerSocketPath } from '../services/agent-volumes/docker-socket';
import type { EnclavePaths } from './paths';

interface VisiblePath {
  label: string;
  source: string;
}

/**
 * Resolves symlinks in the longest existing ancestor, then appends any missing
 * suffix. This matches how a later mkdir/bind operation will resolve a path
 * without requiring the final path to exist during preflight.
 */
export function resolvePathThroughExistingAncestor(candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`Enclave mount policy requires an absolute path: ${candidate}`);
  }

  const missing: string[] = [];
  let existing = path.resolve(candidate);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  const resolvedAncestor = fs.realpathSync.native(existing);
  return path.resolve(resolvedAncestor, ...missing);
}

function pathsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  const leftContainsRight = relativeLeft === '' || (!relativeLeft.startsWith('..') && !path.isAbsolute(relativeLeft));
  const rightContainsLeft = relativeRight === '' || (!relativeRight.startsWith('..') && !path.isAbsolute(relativeRight));
  return leftContainsRight || rightContainsLeft;
}

function mountSource(volume: string): string | undefined {
  const source = volume.split(':', 1)[0];
  return source && path.isAbsolute(source) ? source : undefined;
}

function daemonVisiblePath(source: string, prefix: string | undefined): string {
  const translated = applyHostPathPrefixToVolumes([`${source}:/awf-mount-policy:ro`], prefix)[0];
  return mountSource(translated) ?? source;
}

/**
 * Returns the first custom bind that exposes the Docker socket (or a parent
 * directory containing it) to the primary agent.
 */
export function findDockerSocketExposingMount(config: WrapperConfig): string | undefined {
  const socketPaths = new Set([
    resolveDockerSocketPath(config),
    '/var/run/docker.sock',
    '/run/docker.sock',
  ]);
  const sockets = [...socketPaths].map((socketPath) => ({
    hostLiteral: path.resolve(socketPath),
    hostResolved: resolvePathThroughExistingAncestor(socketPath),
    daemonLiteral: path.resolve(daemonVisiblePath(socketPath, config.dockerHostPathPrefix)),
    daemonResolved: resolvePathThroughExistingAncestor(
      daemonVisiblePath(socketPath, config.dockerHostPathPrefix),
    ),
  }));
  for (const volume of config.volumeMounts ?? []) {
    const source = mountSource(volume);
    if (!source) continue;
    const literalSource = path.resolve(source);
    const resolvedSource = resolvePathThroughExistingAncestor(source);
    const literalDaemonSource = path.resolve(
      daemonVisiblePath(source, config.dockerHostPathPrefix),
    );
    const daemonSource = resolvePathThroughExistingAncestor(
      daemonVisiblePath(source, config.dockerHostPathPrefix),
    );
    if (sockets.some(
      (socket) => pathsOverlap(literalSource, socket.hostLiteral)
        || pathsOverlap(resolvedSource, socket.hostResolved)
        || pathsOverlap(literalDaemonSource, socket.daemonLiteral)
        || pathsOverlap(daemonSource, socket.daemonResolved),
    )) {
      return volume;
    }
  }
  return undefined;
}

/**
 * Returns the union of host paths exposed by Compose/runc, Compose/gVisor, and
 * sbx. The union intentionally includes optional paths even when absent: Docker
 * can create missing bind sources, and a later-created home/tool path must not
 * turn a previously safe private root into an exposed one.
 */
function collectAgentVisiblePaths(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
): VisiblePath[] {
  const home = getRealUserHome();
  const workspace = env.GITHUB_WORKSPACE || cwd;
  const visible: VisiblePath[] = [
    { label: 'temporary directory', source: '/tmp' },
    { label: 'workspace', source: workspace },
    { label: 'sbx system tools', source: '/usr/local/bin' },
    { label: 'Compose chroot home', source: `${config.workDir}-chroot-home` },
    { label: 'AWF work directory', source: config.workDir },
    ...[...systemDirectories(false), ...systemDirectories(true)].map((source) => ({
      label: 'Compose system mount',
      source,
    })),
    ...etcAllowlist().map((source) => ({ label: 'Compose /etc mount', source })),
    { label: 'Compose identity mount', source: '/etc/passwd' },
    { label: 'Compose identity mount', source: '/etc/group' },
    ...HOME_TOOL_SUBDIRS.map((subdir) => ({
      label: `home tool directory ${subdir}`,
      source: path.join(home, subdir),
    })),
    { label: 'runner tool cache fallback', source: path.join(home, 'work', '_tool') },
  ];

  for (const runnerToolCache of [config.runnerToolCachePath, env.RUNNER_TOOL_CACHE]) {
    if (runnerToolCache) {
      visible.push({ label: 'runner tool cache', source: runnerToolCache });
    }
  }
  if (config.sessionStateDir) {
    visible.push({ label: 'agent session-state directory', source: config.sessionStateDir });
  }
  if (config.chrootBinariesSourcePath) {
    visible.push({ label: 'chroot binaries source', source: config.chrootBinariesSourcePath });
  }
  if (config.enableDind) {
    visible.push({ label: 'agent Docker socket', source: resolveDockerSocketPath(config) });
  }
  for (const volume of config.volumeMounts ?? []) {
    const source = mountSource(volume);
    if (!source) {
      throw new Error(`Enclave mount policy could not parse custom bind mount: ${volume}`);
    }
    visible.push({ label: `custom volume ${volume}`, source });
  }

  return visible;
}

/**
 * Fails closed when a server-private root aliases, contains, or is contained
 * by any path visible to a primary agent in any supported sandbox backend.
 *
 * The agent-visible path union is backend-independent, so the check covers
 * every supported primary-agent runtime.
 */
export function assertPrivateRootIsolated(
  config: WrapperConfig,
  roots: Pick<EnclavePaths, 'root' | 'ingressRoot'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  label = 'enclave',
): void {
  const privateRoot = resolvePathThroughExistingAncestor(roots.root);
  const privateDaemonRoot = resolvePathThroughExistingAncestor(
    daemonVisiblePath(roots.root, config.dockerHostPathPrefix),
  );
  const visiblePaths = [
    ...collectAgentVisiblePaths(config, env, cwd),
    { label: `${label} ingress`, source: roots.ingressRoot },
  ];

  for (const visible of visiblePaths) {
    const resolvedVisible = resolvePathThroughExistingAncestor(visible.source);
    const resolvedDaemonVisible = resolvePathThroughExistingAncestor(
      daemonVisiblePath(visible.source, config.dockerHostPathPrefix),
    );
    if (
      pathsOverlap(privateRoot, resolvedVisible)
      || pathsOverlap(privateDaemonRoot, resolvedDaemonVisible)
    ) {
      throw new Error(
        `Unsafe ${label} private root "${roots.root}" overlaps agent-visible ${visible.label} ` +
        `"${visible.source}" after path and symlink resolution`,
      );
    }
  }
}

/**
 * Fails closed when the server-private root aliases, contains, or is contained
 * by any path visible to a primary agent in any supported sandbox backend.
 */
export function assertEnclavePrivateRootIsolated(
  config: WrapperConfig,
  paths: EnclavePaths,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): void {
  assertPrivateRootIsolated(config, paths, env, cwd, 'enclave');
}

/** @internal Exported for focused adversarial tests. */
// ts-prune-ignore-next
export const mountPolicyTestHelpers = {
  collectAgentVisiblePaths,
  daemonVisiblePath,
  pathsOverlap,
};
