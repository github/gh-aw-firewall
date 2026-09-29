import * as fs from 'fs';
import * as path from 'path';
import {
  CLOUD_HYPERVISOR_TMP_GH_AW_EXPORT_TAG,
  CLOUD_HYPERVISOR_WORKSPACE_EXPORT_TAG,
  type CloudHypervisorDirectoryExport,
} from './exports';
import {
  planCloudHypervisorFilesystemWrites,
  summarizeCloudHypervisorFilesystemWriteBoundary,
  type CloudHypervisorFilesystemWritePlan,
} from './filesystem-write-policy';
import type {
  VirtiofsdExportMountPlan,
  VirtiofsdMountEnforcement,
} from './mount-tree';

/** Relative path, inside the `tmp-gh-aw` export, of mcpg's log directory. */
const MCP_LOGS_RELATIVE_PATH = 'mcp-logs';

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
    const plans = withMcpLogsMask(exports, mandatoryPlans);
    return {
      exports,
      ...(plans.length > 0 ? { mountEnforcement: { plans } } : {}),
      writeBoundary: [],
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

  return {
    exports: publishedExports,
    mountEnforcement: { plans: withMcpLogsMask(publishedExports, plans) },
    writeBoundary: summarizeCloudHypervisorFilesystemWriteBoundary(plan),
  };
}

/**
 * Merges a mask for mcpg's log directory into the `tmp-gh-aw` export's mount
 * plan, adding a masks-only plan when that export otherwise has none.
 *
 * MCP Gateway logs the full, pre-filter tool-call payload to
 * `/tmp/gh-aw/mcp-logs` by default. That directory sits inside the `tmp-gh-aw`
 * virtiofs export, which the guest can otherwise read regardless of
 * `filesystem.allowWrite` -- narrowing write access does nothing to narrow
 * read access. Masking the directory closes that read path independently of
 * whether the export ends up read-only, read-write, or selectively writable.
 *
 * Applied unconditionally (not just when `filesystem.allowWrite` is set)
 * because the exposure exists on every run, and only when the directory is
 * confirmed to exist as a real, non-symlinked directory so a missing or
 * unusual host layout degrades to no masking rather than a hard failure.
 */
function withMcpLogsMask(
  exports: readonly CloudHypervisorDirectoryExport[],
  plans: readonly VirtiofsdExportMountPlan[],
): VirtiofsdExportMountPlan[] {
  const maskDestination = resolveMcpLogsMaskDestination(exports);
  if (!maskDestination) return [...plans];
  const index = plans.findIndex((entry) => entry.tag === CLOUD_HYPERVISOR_TMP_GH_AW_EXPORT_TAG);
  if (index === -1) {
    return [
      ...plans,
      {
        tag: CLOUD_HYPERVISOR_TMP_GH_AW_EXPORT_TAG,
        writableOverlays: [],
        maskedPaths: [{ destination: maskDestination }],
      },
    ];
  }
  const existing = plans[index];
  const merged = [...plans];
  merged[index] = {
    ...existing,
    maskedPaths: [...(existing.maskedPaths ?? []), { destination: maskDestination }],
  };
  return merged;
}

function resolveMcpLogsMaskDestination(
  exports: readonly CloudHypervisorDirectoryExport[],
): string | undefined {
  const tmpGhAw = exports.find((entry) => entry.tag === CLOUD_HYPERVISOR_TMP_GH_AW_EXPORT_TAG);
  if (!tmpGhAw) return undefined;
  const candidate = path.join(tmpGhAw.source, MCP_LOGS_RELATIVE_PATH);
  try {
    const resolved = fs.realpathSync(candidate);
    if (resolved !== candidate) return undefined;
    if (!fs.statSync(resolved).isDirectory()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
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
