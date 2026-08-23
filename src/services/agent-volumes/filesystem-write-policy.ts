import * as fs from 'fs';
import * as path from 'path';
import { runtimeUsesComposeAgent } from '../../container-runtime';
import type { WrapperConfig } from '../../types';

/**
 * Resolves the `filesystem.allowWrite` policy that applies to *compose* bind
 * mounts.
 *
 * `filesystem.allowWrite` is expressed in guest-visible paths, and each runtime
 * realises those paths differently. Compose runtimes (Docker, gVisor) express
 * them as host bind mounts, so the policy is enforced by rewriting volume
 * specs. MicroVM runtimes do not: Cloud Hypervisor enforces the same policy
 * against its own virtio-fs exports via a staged host mount tree (see
 * `src/cloud-hypervisor/filesystem-write-enforcement.ts`), and sbx rejects the
 * policy outright in `src/filesystem-policy.ts`.
 *
 * Compose generation still builds an agent service object for microVM runtimes
 * so infra containers can wire `depends_on` edges, even though that service is
 * omitted from the emitted compose file. Without this gate, a microVM policy
 * would be evaluated against compose bind mounts that the agent never uses, and
 * a guest path such as `/workspace/allowed` — perfectly valid for a Cloud
 * Hypervisor export — would throw the Docker "not backed by a writable host
 * mount" error during `writeConfigs()`, long before the Cloud Hypervisor
 * planner ever ran.
 */
export function resolveComposeFilesystemAllowWrite(
  config: Pick<WrapperConfig, 'filesystemAllowWrite' | 'containerRuntime'>,
): string[] | undefined {
  if (!runtimeUsesComposeAgent(config.containerRuntime)) return undefined;
  return config.filesystemAllowWrite;
}

interface BindMount {
  source: string;
  target: string;
  mode: string | undefined;
  logicalTarget: string;
  writable: boolean;
}

function parseBindMount(spec: string): BindMount | undefined {
  const parts = spec.split(':');
  if (parts.length < 2) return undefined;

  const source = parts[0];
  const target = parts[1];
  const mode = parts[2];
  const logicalTarget = target === '/host'
    ? '/'
    : target.startsWith('/host/')
      ? target.slice('/host'.length)
      : target;

  return {
    source,
    target,
    mode,
    logicalTarget: path.posix.normalize(logicalTarget),
    writable: mode !== 'ro',
  };
}

function isPathAtOrBelow(candidate: string, parent: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

function pathDepth(value: string): number {
  return value.split('/').filter(Boolean).length;
}

function withMode(mount: BindMount, mode: 'ro' | 'rw'): string {
  return `${mount.source}:${mount.target}:${mode}`;
}

function resolveWritableOverlay(
  mount: BindMount,
  allowedPath: string,
  localSourceRoot: string,
): string | undefined {
  if (!path.isAbsolute(mount.source) || !isPathAtOrBelow(allowedPath, mount.logicalTarget)) {
    return undefined;
  }

  const relative = path.posix.relative(mount.logicalTarget, allowedPath);
  const localSource = path.join(localSourceRoot, relative);
  if (!fs.existsSync(localSource)) return undefined;

  const realSourceRoot = fs.realpathSync(localSourceRoot);
  const realSource = fs.realpathSync(localSource);
  if (realSource !== path.resolve(realSourceRoot, relative)) return undefined;

  const source = path.join(mount.source, relative);
  const target = mount.target === '/host'
    ? `/host${allowedPath === '/' ? '' : allowedPath}`
    : path.posix.join(mount.target, relative);
  return `${source}:${target}:rw`;
}

/**
 * Narrows existing writable bind mounts to an explicit guest-visible path
 * allowlist. It never makes a previously read-only mount writable and never
 * introduces a host path that was not already exposed by a writable mount.
 */
export function applyFilesystemWritePolicy(
  volumeSpecs: string[],
  allowWrite: string[] | undefined,
  alwaysWritableMounts: ReadonlySet<string> = new Set(),
  localSourceRoots: ReadonlyMap<string, string> = new Map(),
): string[] {
  if (allowWrite === undefined) return volumeSpecs;

  for (const value of allowWrite) {
    if (!path.posix.isAbsolute(value) || value.split('/').includes('..')) {
      throw new Error(`filesystem.allowWrite path must be absolute without '..': ${value}`);
    }
  }

  const normalizedPaths = [...new Set(allowWrite.map((value) => path.posix.normalize(value)))];
  const allowedPaths = normalizedPaths.filter((candidate) =>
    !normalizedPaths.some((parent) => parent !== candidate && isPathAtOrBelow(candidate, parent))
  );
  const mounts = volumeSpecs.map(parseBindMount);
  const overlays = new Set<string>();
  const matched = new Set<string>();

  const transformed = volumeSpecs.map((spec, index) => {
    const mount = mounts[index];
    if (!mount || !mount.writable) return spec;

    if (alwaysWritableMounts.has(spec)) {
      return withMode(mount, 'rw');
    }

    for (const allowedPath of allowedPaths) {
      if (isPathAtOrBelow(mount.logicalTarget, allowedPath)) {
        matched.add(allowedPath);
        return withMode(mount, 'rw');
      }

      const coveringMounts = mounts.filter((candidate): candidate is BindMount =>
        candidate !== undefined && isPathAtOrBelow(allowedPath, candidate.logicalTarget)
      );
      const deepestTarget = Math.max(...coveringMounts.map((candidate) => pathDepth(candidate.logicalTarget)));
      const deepestMounts = coveringMounts.filter(
        (candidate) => pathDepth(candidate.logicalTarget) === deepestTarget,
      );
      if (
        pathDepth(mount.logicalTarget) !== deepestTarget ||
        deepestMounts.some((candidate) => !candidate.writable)
      ) {
        continue;
      }

      const overlay = resolveWritableOverlay(
        mount,
        allowedPath,
        localSourceRoots.get(spec) ?? mount.source,
      );
      if (overlay) {
        matched.add(allowedPath);
        overlays.add(overlay);
      }
    }

    return withMode(mount, 'ro');
  });

  const unmatched = allowedPaths.filter((allowedPath) => !matched.has(allowedPath));
  if (unmatched.length > 0) {
    throw new Error(
      `filesystem.allowWrite path is not an existing path within a writable host mount: ${unmatched.join(', ')}`,
    );
  }

  return [...transformed, ...overlays];
}
