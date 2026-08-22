import * as fs from 'fs';
import * as path from 'path';

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

function withMode(mount: BindMount, mode: 'ro' | 'rw'): string {
  return `${mount.source}:${mount.target}:${mode}`;
}

function resolveWritableOverlay(mount: BindMount, allowedPath: string): string | undefined {
  if (!path.isAbsolute(mount.source) || !isPathAtOrBelow(allowedPath, mount.logicalTarget)) {
    return undefined;
  }

  const relative = path.posix.relative(mount.logicalTarget, allowedPath);
  const source = path.join(mount.source, relative);
  if (!fs.existsSync(source)) return undefined;

  const realSourceRoot = fs.realpathSync(mount.source);
  const realSource = fs.realpathSync(source);
  if (!isPathAtOrBelow(realSource, realSourceRoot)) return undefined;

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
  alwaysWritablePaths: string[] = [],
): string[] {
  if (allowWrite === undefined) return volumeSpecs;

  const allowedPaths = allowWrite.map((value) => path.posix.normalize(value));
  const internalPaths = alwaysWritablePaths.map((value) => path.posix.normalize(value));
  const mounts = volumeSpecs.map(parseBindMount);
  const overlays = new Set<string>();
  const matched = new Set<string>();

  const transformed = volumeSpecs.map((spec, index) => {
    const mount = mounts[index];
    if (!mount || !mount.writable) return spec;

    if (internalPaths.some((internalPath) => isPathAtOrBelow(mount.logicalTarget, internalPath))) {
      return withMode(mount, 'rw');
    }

    for (const allowedPath of allowedPaths) {
      if (isPathAtOrBelow(mount.logicalTarget, allowedPath)) {
        matched.add(allowedPath);
        return withMode(mount, 'rw');
      }
      const overlay = resolveWritableOverlay(mount, allowedPath);
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
