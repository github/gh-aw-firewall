import { promises as fs } from 'fs';
import * as path from 'path';
import type { NvxDirectoryExport } from './workspace-export';

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
 * Plans how `filesystem.allowWrite` narrows NVX live directory shares.
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
    const stat = await assertNoSymlinkComponents(
      owner.source,
      hostCandidate,
      allowed,
      realpath,
      lstat,
    );
    const hostPath = hostCandidate;

    async function assertNoSymlinkComponents(
      root: string,
      candidate: string,
      guestPath: string,
      realpath: (target: string) => Promise<string>,
      lstat: NonNullable<NvxFilesystemWritePolicyOptions['lstat']>,
    ): Promise<Awaited<ReturnType<typeof lstat>>> {
      const relative = path.relative(root, candidate);
      let current = root;
      let finalStat: Awaited<ReturnType<typeof lstat>> | undefined;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        let stat: Awaited<ReturnType<typeof lstat>>;
        try {
          stat = await lstat(current);
        } catch {
          throw new Error(
            `filesystem.allowWrite path does not exist on the host: ${guestPath}`,
          );
        }
        if (stat.isSymbolicLink()) {
          throw new Error(`filesystem.allowWrite path must not contain symlinks: ${guestPath}`);
        }
        let canonical: string;
        try {
          canonical = await realpath(current);
        } catch {
          throw new Error(
            `filesystem.allowWrite path does not exist on the host: ${guestPath}`,
          );
        }
        if (canonical !== current) {
          throw new Error(`filesystem.allowWrite path must be canonical: ${guestPath}`);
        }
        finalStat = stat;
      }
      if (!finalStat) throw new Error(`filesystem.allowWrite path is invalid: ${guestPath}`);
      return finalStat;
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
        overlays: [],
      };
    }
    if (internalTags.has(entry.tag)) {
      return {
        export: entry,
        disposition: 'writable',
        overlays: [],
      };
    }
    const overlays = overlaysByTag.get(entry.tag);
    if (overlays === undefined) {
      return {
        export: entry,
        disposition: 'read-only',
        overlays: [],
      };
    }
    if (overlays.length === 0) {
      return {
        export: entry,
        disposition: 'writable',
        overlays: [],
      };
    }
    return {
      export: entry,
      disposition: 'selective',
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
