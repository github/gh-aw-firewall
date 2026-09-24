import { promises as fs } from 'fs';
import * as path from 'path';
import type { NvxDirectoryExport, NvxExportMode } from './workspace-export';

/**
 * How a single NVX guest export is affected by `filesystem.allowWrite`.
 *
 * - `unrestricted`: no policy was supplied, the declared export mode stands.
 * - `read-only`: nothing inside the export may be written by the guest.
 * - `writable`: the whole export stays writable.
 * - `selective`: the export is staged read-only except for the listed overlays.
 */
export type NvxExportWriteDisposition =
  | 'unrestricted'
  | 'read-only'
  | 'writable'
  | 'selective';

/**
 * A host/guest path pair that must stay writable inside an otherwise read-only
 * export. `guestPath` is only lexically normalized (the guest filesystem does
 * not exist at planning time) while `hostPath` is realpath-canonical and
 * verified not to escape the export source.
 */
export interface NvxWritableOverlay {
  readonly exportTag: string;
  readonly guestPath: string;
  readonly hostPath: string;
  /** Path of the overlay relative to the export target/source root. */
  readonly relativePath: string;
  readonly kind: 'directory' | 'file';
}

export interface NvxExportWritePlan {
  readonly export: NvxDirectoryExport;
  readonly disposition: NvxExportWriteDisposition;
  /**
   * Ownership the export's staged tree must carry inside the guest's `custom`
   * EROFS layer.
   *
   * `workload` stages the tree owned by the guest workload identity, so the
   * overlay can copy entries up into the writable scratch layer. `root` stages
   * it owned by uid/gid 0 with the write bits cleared: the workload runs with
   * an empty capability set (no `CAP_FOWNER`/`CAP_DAC_OVERRIDE`), so it can
   * neither write the entry nor `chmod` it back to writable.
   */
  readonly stagedOwnership: 'workload' | 'root';
  readonly overlays: readonly NvxWritableOverlay[];
}

export interface NvxFilesystemWritePlan {
  /** False when `filesystem.allowWrite` was absent (`undefined`). */
  readonly restricted: boolean;
  /** Normalized allowlist with duplicates and covered descendants removed. */
  readonly allowedPaths: readonly string[];
  readonly exports: readonly NvxExportWritePlan[];
  /** Every overlay across all exports, in export order. */
  readonly overlays: readonly NvxWritableOverlay[];
}

export interface NvxFilesystemWritePolicyOptions {
  /**
   * Tags of AWF-owned exports that must remain writable for the run to work.
   * They are never narrowed; an allowlist entry resolving inside one is still
   * consumed (so it is not reported unmatched) but produces no overlay.
   */
  readonly internalTags?: Iterable<string>;
  /**
   * Resolves a host path to its canonical form. Injected so the planner stays
   * unit-testable without touching the filesystem.
   */
  readonly realpath?: (target: string) => Promise<string>;
  readonly lstat?: (target: string) => Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
}

/**
 * Plans how `filesystem.allowWrite` narrows the directories AWF stages into the
 * NVX guest's `custom` layer.
 *
 * The planner only ever removes write access: it never upgrades a read-only
 * export and never exposes a host path that is not already reachable through an
 * existing read-write export. It is pure policy planning and performs no
 * staging, launching, or other side effects.
 */
export async function planNvxFilesystemWrites(
  entries: readonly NvxDirectoryExport[],
  allowWrite: readonly string[] | undefined,
  options: NvxFilesystemWritePolicyOptions = {},
): Promise<NvxFilesystemWritePlan> {
  const internalTags = new Set(options.internalTags ?? []);
  if (allowWrite === undefined) {
    return {
      restricted: false,
      allowedPaths: [],
      exports: entries.map((entry) => ({
        export: entry,
        disposition: 'unrestricted',
        stagedOwnership: stagedOwnershipFor(entry.mode),
        overlays: [],
      })),
      overlays: [],
    };
  }

  const realpath = options.realpath ?? ((target: string) => fs.realpath(target));
  const lstat = options.lstat ?? ((target: string) => fs.lstat(target));
  const allowedPaths = normalizeAllowedPaths(allowWrite);
  const overlaysByTag = new Map<string, NvxWritableOverlay[]>();
  const unmatched: string[] = [];

  for (const allowed of allowedPaths) {
    const owner = deepestWritableExport(entries, allowed);
    if (!owner) {
      unmatched.push(allowed);
      continue;
    }
    if (internalTags.has(owner.tag)) continue;
    const relativePath = allowed === owner.target
      ? ''
      : allowed.slice(owner.target.length + 1);
    if (relativePath === '') {
      // The whole export is allowed; record no overlay and let the export stay
      // writable by clearing any narrower overlays collected for it.
      overlaysByTag.set(owner.tag, []);
      continue;
    }
    const hostCandidate = path.join(owner.source, relativePath);
    const hostPath = await realpath(hostCandidate).catch(() => {
      throw new Error(
        `filesystem.allowWrite path does not exist on the host: ${allowed}`,
      );
    });
    if (hostPath !== owner.source && !hostPath.startsWith(`${owner.source}/`)) {
      throw new Error(
        `filesystem.allowWrite path escapes its export via a symlink: ${allowed}`,
      );
    }
    const stat = await lstat(hostCandidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`filesystem.allowWrite path must not be a symlink: ${allowed}`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(
        `filesystem.allowWrite path must be a regular file or directory: ${allowed}`,
      );
    }
    const overlays = overlaysByTag.get(owner.tag) ?? [];
    overlays.push({
      exportTag: owner.tag,
      guestPath: allowed,
      hostPath,
      relativePath,
      kind: stat.isDirectory() ? 'directory' : 'file',
    });
    overlaysByTag.set(owner.tag, overlays);
  }

  if (unmatched.length > 0) {
    throw new Error(
      'filesystem.allowWrite paths are not inside any writable NVX guest export: ' +
      unmatched.join(', '),
    );
  }

  const exportPlans = entries.map((entry): NvxExportWritePlan => {
    if (entry.mode === 'ro') {
      return {
        export: entry,
        disposition: 'read-only',
        stagedOwnership: 'root',
        overlays: [],
      };
    }
    if (internalTags.has(entry.tag)) {
      return {
        export: entry,
        disposition: 'writable',
        stagedOwnership: 'workload',
        overlays: [],
      };
    }
    const overlays = overlaysByTag.get(entry.tag);
    if (overlays === undefined) {
      return {
        export: entry,
        disposition: 'read-only',
        stagedOwnership: 'root',
        overlays: [],
      };
    }
    if (overlays.length === 0) {
      return {
        export: entry,
        disposition: 'writable',
        stagedOwnership: 'workload',
        overlays: [],
      };
    }
    return {
      export: entry,
      disposition: 'selective',
      stagedOwnership: 'root',
      overlays,
    };
  });

  return {
    restricted: true,
    allowedPaths,
    exports: exportPlans,
    overlays: exportPlans.flatMap((plan) => plan.overlays),
  };
}

/**
 * True when the guest is permitted to persist writes at `guestPath` back to the
 * host. Used as the copy-back filter so a guest that somehow wrote outside the
 * policy cannot smuggle the change onto the host.
 */
export function isNvxWritableGuestPath(
  plan: NvxFilesystemWritePlan,
  guestPath: string,
): boolean {
  const normalized = path.posix.normalize(guestPath);
  for (const exportPlan of plan.exports) {
    if (!isWithin(normalized, exportPlan.export.target)) continue;
    switch (exportPlan.disposition) {
      case 'unrestricted':
        return exportPlan.export.mode === 'rw';
      case 'writable':
        return true;
      case 'read-only':
        return false;
      case 'selective':
        return exportPlan.overlays.some((overlay) => (
          isWithin(normalized, overlay.guestPath)
        ));
    }
  }
  return false;
}

function stagedOwnershipFor(mode: NvxExportMode): 'workload' | 'root' {
  return mode === 'rw' ? 'workload' : 'root';
}

function deepestWritableExport(
  entries: readonly NvxDirectoryExport[],
  guestPath: string,
): NvxDirectoryExport | undefined {
  let match: NvxDirectoryExport | undefined;
  for (const entry of entries) {
    if (entry.mode !== 'rw') continue;
    if (!isWithin(guestPath, entry.target)) continue;
    if (!match || entry.target.length > match.target.length) match = entry;
  }
  return match;
}

function normalizeAllowedPaths(allowWrite: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const entry of allowWrite) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!path.posix.isAbsolute(trimmed)) {
      throw new Error(`filesystem.allowWrite entries must be absolute: ${entry}`);
    }
    if (trimmed.split('/').includes('..')) {
      throw new Error(`filesystem.allowWrite entries must not traverse upwards: ${entry}`);
    }
    const candidate = path.posix.normalize(trimmed).replace(/\/+$/, '') || '/';
    if (!normalized.includes(candidate)) normalized.push(candidate);
  }
  return normalized
    .filter((candidate, _index, all) => !all.some(
      (other) => other !== candidate && isWithin(candidate, other),
    ))
    .sort();
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}
