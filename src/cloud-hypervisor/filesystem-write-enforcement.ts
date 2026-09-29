import * as fs from 'fs';
import * as path from 'path';
import {
  CLOUD_HYPERVISOR_TMP_GH_AW_EXPORT_TAG,
  CLOUD_HYPERVISOR_WORKSPACE_EXPORT_TAG,
  type CloudHypervisorDirectoryExport,
} from './exports';
import {
  EXPLICITLY_SAFE_GH_AW_CHILDREN,
  SENSITIVE_PATH_EXEMPTIONS,
  resolveSensitivePaths,
  type ResolvedSensitivePath,
} from '../sensitive-paths';
import {
  planCloudHypervisorFilesystemWrites,
  summarizeCloudHypervisorFilesystemWriteBoundary,
  type CloudHypervisorFilesystemWritePlan,
} from './filesystem-write-policy';
import type {
  VirtiofsdExportMountPlan,
  VirtiofsdMountEnforcement,
} from './mount-tree';

/**
 * Translation layer between the pure `filesystem.allowWrite` planner
 * (`./filesystem-write-policy.ts`) and the host mount-tree enforcement API
 * consumed by `VirtiofsdManager.start()` (`./mount-tree.ts`).
 *
 * The planner decides *what* stays writable; the mount tree decides *how* that
 * is enforced on the host. This module only re-expresses one in the other's
 * vocabulary — it repeats no validation and applies no policy of its own.
 */
export interface CloudHypervisorFilesystemWriteEnforcement {
  /**
   * Exports as published to virtiofsd, the guest boot arguments, and the guest
   * environment. Identical to the resolved exports when no policy is in force;
   * otherwise each mode is replaced by the planner's `guestMountMode`.
   */
  readonly exports: readonly CloudHypervisorDirectoryExport[];
  /**
   * Host mount-tree enforcement. This is always present for an opted-in runner
   * tool cache so carried-in submounts are recursively verified read-only, and
   * may also be present when `filesystem.allowWrite` narrows writable exports.
   */
  readonly mountEnforcement?: VirtiofsdMountEnforcement;
  /**
   * Human-readable description of the resolved write boundary, one entry per
   * export. Empty when `filesystem.allowWrite` was absent, so callers log
   * nothing for an unrestricted run.
   */
  readonly writeBoundary: readonly string[];
  /** Registry entries that resolve to existing directories inside published exports. */
  readonly sensitiveMasks: readonly ResolvedSensitivePath[];
  /** Immediate `/tmp/gh-aw` children without an explicit safety classification. */
  readonly unclassifiedPaths: readonly string[];
}

/**
 * Plans `filesystem.allowWrite` for the resolved Cloud Hypervisor exports and
 * translates the result into published exports plus host mount-tree
 * enforcement.
 *
 * No `internalTags` are declared. Cloud Hypervisor has no counterpart to the
 * always-writable Docker agent-log and session-state binds: agent output leaves
 * the guest over vsock, and diagnostics are written by the host into the per-run
 * directory, which is not an export at all. In particular `tmp-gh-aw` is *not*
 * internal — the motivating policy allows only `/tmp/gh-aw/agent`, and exempting
 * the whole export would silently widen it back to fully writable.
 *
 * The runner tool cache is a separate mandatory boundary: even without an
 * allowlist it receives a zero-overlay mount plan so nested host mounts cannot
 * bypass the declared read-only export mode.
 */
export function planCloudHypervisorFilesystemWriteEnforcement(
  exports: readonly CloudHypervisorDirectoryExport[],
  allowWrite: string[] | undefined,
): CloudHypervisorFilesystemWriteEnforcement {
  return toCloudHypervisorFilesystemWriteEnforcement(
    planCloudHypervisorFilesystemWrites(exports, allowWrite),
  );
}

/** @internal Split out so translation is testable against a synthetic plan. */
// ts-prune-ignore-next
export function toCloudHypervisorFilesystemWriteEnforcement(
  plan: CloudHypervisorFilesystemWritePlan,
): CloudHypervisorFilesystemWriteEnforcement {
  if (!plan.restricted) {
    const exports = plan.exports.map((entry) => entry.export);
    const mandatoryPlans = exports
      .filter((entry) => entry.tag === 'runner-tool-cache' && entry.mode === 'ro')
      .map((entry) => ({ tag: entry.tag, writableOverlays: [] }));
    const { plans, sensitiveMasks, unclassifiedPaths } =
      withSensitivePathMasks(exports, mandatoryPlans);
    return {
      exports,
      ...(plans.length > 0 ? { mountEnforcement: { plans } } : {}),
      writeBoundary: [],
      sensitiveMasks,
      unclassifiedPaths,
    };
  }

  const plans: VirtiofsdExportMountPlan[] = [];
  const publishedExports = plan.exports.map((entry) => {
    // `hostRootMode: 'ro'` covers both a fully read-only export (zero overlays)
    // and a selective one. Both are staged through the recursively verified
    // mount tree rather than the legacy single read-only bind, which cannot
    // prove that carried-in submounts are read-only.
    if (entry.hostRootMode === 'ro') {
      plans.push({
        tag: entry.export.tag,
        writableOverlays: entry.overlays.map((overlay) => ({
          // The planner already resolved a realpath-canonical host path that is
          // contained in the export source; it is both the bind source and the
          // destination whose staged counterpart becomes writable.
          source: overlay.hostPath,
          destination: overlay.hostPath,
          kind: overlay.kind,
        })),
      });
    }
    return { ...entry.export, mode: entry.guestMountMode };
  });

  const { plans: enforcedPlans, sensitiveMasks, unclassifiedPaths } =
    withSensitivePathMasks(publishedExports, plans);
  return {
    exports: publishedExports,
    mountEnforcement: { plans: enforcedPlans },
    writeBoundary: summarizeCloudHypervisorFilesystemWriteBoundary(plan),
    sensitiveMasks,
    unclassifiedPaths,
  };
}

/**
 * Applies every registered mask whose existing directory is inside a published
 * export. A path that exists but is a symlink or non-directory fails closed.
 */
function withSensitivePathMasks(
  exports: readonly CloudHypervisorDirectoryExport[],
  plans: readonly VirtiofsdExportMountPlan[],
): {
  plans: VirtiofsdExportMountPlan[];
  sensitiveMasks: ResolvedSensitivePath[];
  unclassifiedPaths: string[];
} {
  const sensitivePaths = resolveSensitivePaths('cloud-hypervisor');
  const resolvedMasks = sensitivePaths
    .map((entry) => resolvePathInExport(entry, exports))
    .filter((entry): entry is { export: CloudHypervisorDirectoryExport; mask: ResolvedSensitivePath } =>
      entry !== undefined)
    .map((entry) => {
      ensureRealDirectoryWithinRoot(entry.export.source, entry.mask.path);
      return entry;
    });
  const sensitiveMasks = resolvedMasks.map(({ mask }) => mask);
  const maskedByTag = new Map<string, ResolvedSensitivePath[]>();
  for (const { export: exportEntry, mask } of resolvedMasks) {
    const masks = maskedByTag.get(exportEntry.tag) ?? [];
    masks.push(mask);
    maskedByTag.set(exportEntry.tag, masks);
  }

  const enforcedPlans = [...plans];
  for (const [tag, masks] of maskedByTag) {
    const index = enforcedPlans.findIndex((entry) => entry.tag === tag);
    const maskedPaths = masks.map(({ path: destination }) => ({ destination }));
    if (index === -1) {
      enforcedPlans.push({ tag, writableOverlays: [], maskedPaths });
    } else {
      enforcedPlans[index] = {
        ...enforcedPlans[index],
        maskedPaths: [...(enforcedPlans[index].maskedPaths ?? []), ...maskedPaths],
      };
    }
  }
  return {
    plans: enforcedPlans,
    sensitiveMasks,
    unclassifiedPaths: findUnclassifiedGhAwChildren(exports),
  };
}

function resolvePathInExport(
  entry: ResolvedSensitivePath,
  exports: readonly CloudHypervisorDirectoryExport[],
): { export: CloudHypervisorDirectoryExport; mask: ResolvedSensitivePath } | undefined {
  const exportEntry = exports.find((item) => containsOrEquals(item.target, entry.path));
  if (!exportEntry) return undefined;
  const relative = path.relative(exportEntry.target, entry.path);
  return {
    export: exportEntry,
    mask: {
      ...entry,
      path: relative ? path.join(exportEntry.source, relative) : exportEntry.source,
    },
  };
}

function ensureRealDirectoryWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Sensitive path escapes its Cloud Hypervisor export: ${candidate}`);
  }
  assertRealDirectory(root);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      assertRealDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      assertRealDirectory(current);
    }
  }
}

function assertRealDirectory(candidate: string): void {
  const lstat: fs.Stats = fs.lstatSync(candidate);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Sensitive path must not be a symlink: ${candidate}`);
  }
  if (!lstat.isDirectory()) {
    throw new Error(`Sensitive path must be a directory: ${candidate}`);
  }
  const resolved = fs.realpathSync(candidate);
  if (resolved !== candidate) {
    throw new Error(`Sensitive path must be canonical: ${candidate} resolves to ${resolved}`);
  }
}

function findUnclassifiedGhAwChildren(
  exports: readonly CloudHypervisorDirectoryExport[],
): string[] {
  const tmpGhAw = exports.find((entry) => entry.tag === CLOUD_HYPERVISOR_TMP_GH_AW_EXPORT_TAG);
  if (!tmpGhAw) return [];
  const classifiedChildren = new Set<string>(EXPLICITLY_SAFE_GH_AW_CHILDREN);
  for (const entry of resolveSensitivePaths('cloud-hypervisor')) {
    const relative = path.relative(tmpGhAw.target, entry.path);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      classifiedChildren.add(relative.split(path.sep)[0]);
    }
  }
  for (const entry of SENSITIVE_PATH_EXEMPTIONS) {
    const relative = path.relative(tmpGhAw.target, entry.path);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      classifiedChildren.add(relative.split(path.sep)[0]);
    }
  }
  return fs.readdirSync(tmpGhAw.source)
    .filter((child) => !classifiedChildren.has(child))
    .map((child) => path.join(tmpGhAw.source, child))
    .sort();
}

function containsOrEquals(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * True when the workspace export is staged read-only on the host, which is the
 * only circumstance under which it may be published to the guest read-only.
 */
export function hasReadOnlyWorkspaceMountPlan(
  enforcement: VirtiofsdMountEnforcement | undefined,
): boolean {
  return enforcement?.plans.some(
    (plan) => plan.tag === CLOUD_HYPERVISOR_WORKSPACE_EXPORT_TAG,
  ) === true;
}
