import {
  CLOUD_HYPERVISOR_WORKSPACE_EXPORT_TAG,
  type CloudHypervisorDirectoryExport,
} from './exports';
import {
  planCloudHypervisorFilesystemWrites,
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
   * Host mount-tree enforcement, or `undefined` when `filesystem.allowWrite`
   * was absent. `undefined` is what preserves byte-identical legacy staging,
   * including virtiofsd's argument vector.
   */
  readonly mountEnforcement?: VirtiofsdMountEnforcement;
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
    // No policy: the exports and the virtiofsd invocation must be exactly what
    // they were before this feature existed, so no enforcement is produced.
    return { exports: plan.exports.map((entry) => entry.export) };
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

  return { exports: publishedExports, mountEnforcement: { plans } };
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
