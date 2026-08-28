import * as fs from 'fs';
import * as path from 'path';
import type { CloudHypervisorDirectoryExport, CloudHypervisorExportMode } from './exports';

/**
 * How a single Cloud Hypervisor directory export is affected by
 * `filesystem.allowWrite`.
 *
 * - `unrestricted`: no policy was supplied, the declared export mode stands.
 * - `read-only`: the export is exposed read-only under the policy.
 * - `writable`: the whole export stays read-write.
 * - `selective`: the host backing tree is staged read-only outside the listed
 *   overlays, which stay read-write.
 */
export type CloudHypervisorExportWriteDisposition =
  | 'unrestricted'
  | 'read-only'
  | 'writable'
  | 'selective';

/**
 * A host/guest path pair that must stay writable inside an otherwise read-only
 * export. Both paths are absolute, but they are canonical in different senses:
 * `guestPath` is only lexically normalized (the guest filesystem does not exist
 * yet at planning time), while `hostPath` is realpath-canonical and verified not
 * to escape the export source.
 */
export interface CloudHypervisorWritableOverlay {
  /** Tag of the export this overlay is carved out of. */
  readonly exportTag: string;
  /** Guest-visible absolute path that must be writable, lexically normalized. */
  readonly guestPath: string;
  /** Realpath-canonical host path backing {@link guestPath}. */
  readonly hostPath: string;
  /** Path of the overlay relative to the export target/source root. */
  readonly relativePath: string;
  readonly kind: 'directory' | 'file';
}

export interface CloudHypervisorExportWritePlan {
  readonly export: CloudHypervisorDirectoryExport;
  readonly disposition: CloudHypervisorExportWriteDisposition;
  /**
   * Mode the host backing tree root must be staged with. `ro` means the host
   * VFS — a read-only bind of the export source, as `virtiofsd.ts` already does
   * for read-only exports — is what denies writes, independently of any guest
   * mount flag.
   */
  readonly hostRootMode: CloudHypervisorExportMode;
  /**
   * Mode the guest virtio-fs mount must use.
   *
   * A `selective` export deliberately reports `rw` here while `hostRootMode` is
   * `ro`. Mounting the composite tree read-only in the guest would also block
   * the writable overlays: virtio-fs submounts are attached through
   * `d_automount`, and `finish_automount()` calls
   * `do_add_mount(..., path->mnt->mnt_flags | MNT_SHRINKABLE)`, so an announced
   * submount inherits `MNT_READONLY` from its parent mount. Guest-side `ro` is
   * therefore only correct when the whole export is read-only.
   */
  readonly guestMountMode: CloudHypervisorExportMode;
  /** True when the export is AWF-owned and stays writable under any policy. */
  readonly internal: boolean;
  /** Non-empty only when {@link disposition} is `selective`. */
  readonly overlays: readonly CloudHypervisorWritableOverlay[];
}

export interface CloudHypervisorFilesystemWritePlan {
  /** False when `filesystem.allowWrite` was absent (`undefined`). */
  readonly restricted: boolean;
  /** Normalized allowlist with duplicates and covered descendants removed. */
  readonly allowedPaths: readonly string[];
  readonly exports: readonly CloudHypervisorExportWritePlan[];
  /** Every overlay across all exports, in export order. */
  readonly overlays: readonly CloudHypervisorWritableOverlay[];
}

export interface CloudHypervisorFilesystemWritePolicyOptions {
  /**
   * Tags of AWF-owned exports that must remain writable for the sandbox to
   * operate. They are never narrowed, mirroring the always-writable Docker
   * mounts. An allowlist entry that resolves inside such an export is still
   * validated and consumed, so it is not reported as unmatched, but it produces
   * no overlay because the whole export is already writable.
   */
  readonly internalTags?: Iterable<string>;
}

/**
 * Plans how `filesystem.allowWrite` narrows Cloud Hypervisor directory exports.
 *
 * The planner only ever removes write access: it never upgrades a read-only
 * export and never exposes a host path that is not already reachable through an
 * existing read-write export. `exports` is expected to already satisfy
 * {@link validateCloudHypervisorExports}; overlapping targets are tolerated so
 * that a future export layout resolves to the deepest matching export.
 *
 * This module is pure policy planning: it computes a plan and performs no
 * mounting, launching, or other side effects.
 */
export function planCloudHypervisorFilesystemWrites(
  exports: readonly CloudHypervisorDirectoryExport[],
  allowWrite: string[] | undefined,
  options: CloudHypervisorFilesystemWritePolicyOptions = {},
): CloudHypervisorFilesystemWritePlan {
  const internalTags = new Set(options.internalTags ?? []);

  if (allowWrite === undefined) {
    return {
      restricted: false,
      allowedPaths: [],
      exports: exports.map((entry) => ({
        export: entry,
        disposition: 'unrestricted',
        hostRootMode: entry.mode,
        guestMountMode: entry.mode,
        internal: internalTags.has(entry.tag),
        overlays: [],
      })),
      overlays: [],
    };
  }

  const allowedPaths = normalizeAllowedPaths(allowWrite);
  const matched = new Set<string>();
  const plans: CloudHypervisorExportWritePlan[] = exports.map((entry) => {
    const internal = internalTags.has(entry.tag);
    if (entry.mode !== 'rw') {
      return {
        export: entry,
        disposition: 'read-only',
        hostRootMode: 'ro',
        guestMountMode: 'ro',
        internal,
        overlays: [],
      };
    }
    // An internal export stays fully writable, but it still consumes allowlist
    // entries it covers so they are not misreported as unmatched. As above, only
    // an exact target match is taken directly; a nested path goes through the
    // same existence/realpath validation as a normal overlay. The resolved
    // overlay is discarded because the whole export is already writable.
    if (internal) {
      for (const allowedPath of allowedPaths) {
        if (
          allowedPath === entry.target ||
          (isDeepestWritableExport(exports, entry, allowedPath) &&
            resolveWritableOverlay(entry, allowedPath) !== undefined)
        ) {
          matched.add(allowedPath);
        }
      }
      return {
        export: entry,
        disposition: 'writable',
        hostRootMode: 'rw',
        guestMountMode: 'rw',
        internal,
        overlays: [],
      };
    }

    const overlays: CloudHypervisorWritableOverlay[] = [];
    for (const allowedPath of allowedPaths) {
      // Only an exact match against the export target keeps the whole export
      // writable. A strict ancestor (e.g. `/` above `/workspace`) is not itself
      // an existing path reachable within this export, so it must go through
      // the same host-resolution as any other overlay candidate below.
      if (allowedPath === entry.target) {
        matched.add(allowedPath);
        return {
          export: entry,
          disposition: 'writable',
          hostRootMode: 'rw',
          guestMountMode: 'rw',
          internal,
          overlays: [],
        };
      }
      if (!isDeepestWritableExport(exports, entry, allowedPath)) continue;

      const overlay = resolveWritableOverlay(entry, allowedPath);
      if (overlay) {
        matched.add(allowedPath);
        overlays.push(overlay);
      }
    }

    // A selective export keeps a read-write guest mount so that writable
    // overlays are not blocked by an inherited MNT_READONLY; the read-only host
    // backing tree is what denies writes everywhere else.
    return {
      export: entry,
      disposition: overlays.length > 0 ? 'selective' : 'read-only',
      hostRootMode: 'ro',
      guestMountMode: overlays.length > 0 ? 'rw' : 'ro',
      internal,
      overlays,
    };
  });

  const unmatched = allowedPaths.filter((allowedPath) => !matched.has(allowedPath));
  if (unmatched.length > 0) {
    throw new Error(
      'filesystem.allowWrite path is not an existing path within a writable ' +
      `Cloud Hypervisor export: ${unmatched.join(', ')}`,
    );
  }

  return {
    restricted: true,
    allowedPaths,
    exports: plans,
    overlays: plans.flatMap((plan) => plan.overlays),
  };
}

/**
 * Renders the effective write boundary as one human-readable line per export.
 *
 * `filesystem.allowWrite` narrows guest paths that the workload never declared
 * itself, so a directory that is simply absent from the list fails at write
 * time with a bare `EROFS` and no indication of where the read-only view came
 * from. Reporting the resolved boundary once, before the guest boots, is what
 * turns that into an answerable question.
 *
 * Returns an empty list when no policy is in force: there is no boundary to
 * describe and nothing should be logged.
 */
export function summarizeCloudHypervisorFilesystemWriteBoundary(
  plan: CloudHypervisorFilesystemWritePlan,
): string[] {
  if (!plan.restricted) return [];

  return plan.exports.map((entry) => {
    const target = entry.export.target;
    switch (entry.disposition) {
      case 'writable':
        return `${target}=rw`;
      case 'selective':
        return `${target}=ro except ${entry.overlays.map((overlay) => overlay.guestPath).join(',')}`;
      default:
        return `${target}=ro`;
    }
  });
}

function normalizeAllowedPaths(allowWrite: readonly string[]): string[] {
  for (const value of allowWrite) {
    if (!path.posix.isAbsolute(value) || value.split('/').includes('..') || value.includes('\0')) {
      throw new Error(`filesystem.allowWrite path must be absolute without '..': ${value}`);
    }
  }

  const normalized = [...new Set(allowWrite.map(normalizeGuestPath))];
  return normalized.filter((candidate) =>
    !normalized.some((parent) => parent !== candidate && isPathAtOrBelow(candidate, parent))
  );
}

/**
 * Current export validation rejects overlapping targets, so at most one export
 * matches today. The deepest-match rule keeps the planner correct if nested
 * exports are ever introduced, and refuses to widen a nested read-only export.
 */
function isDeepestWritableExport(
  exports: readonly CloudHypervisorDirectoryExport[],
  entry: CloudHypervisorDirectoryExport,
  allowedPath: string,
): boolean {
  const covering = exports.filter((candidate) => isPathAtOrBelow(allowedPath, candidate.target));
  if (!covering.includes(entry)) return false;

  const deepest = Math.max(...covering.map((candidate) => pathDepth(candidate.target)));
  if (pathDepth(entry.target) !== deepest) return false;
  return !covering.some(
    (candidate) => pathDepth(candidate.target) === deepest && candidate.mode !== 'rw',
  );
}

function resolveWritableOverlay(
  entry: CloudHypervisorDirectoryExport,
  allowedPath: string,
): CloudHypervisorWritableOverlay | undefined {
  const relativePath = path.posix.relative(entry.target, allowedPath);
  if (relativePath === '') return undefined;

  let realSourceRoot: string;
  let realSource: string;
  let stats: fs.Stats;
  try {
    realSourceRoot = fs.realpathSync(entry.source);
    realSource = fs.realpathSync(path.join(entry.source, relativePath));
    stats = fs.statSync(realSource);
  } catch {
    return undefined;
  }

  // Same invariant as the Docker policy: the allowlist may not escape the
  // export source through a symlink anywhere below its root.
  if (realSource !== path.resolve(realSourceRoot, relativePath)) return undefined;
  if (!stats.isDirectory() && !stats.isFile()) return undefined;

  return {
    exportTag: entry.tag,
    guestPath: allowedPath,
    hostPath: realSource,
    relativePath,
    kind: stats.isDirectory() ? 'directory' : 'file',
  };
}

function normalizeGuestPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function isPathAtOrBelow(candidate: string, parent: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

function pathDepth(value: string): number {
  return value.split('/').filter(Boolean).length;
}
