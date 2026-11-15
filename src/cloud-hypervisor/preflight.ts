import { promises as fs } from 'fs';
import type { CloudHypervisorArtifactDigests, CloudHypervisorOptions } from '../types/runtime-options';
import {
  buildExecutionFailureDiagnostics,
  describeAcl,
  describeMountForPath,
  describePathComponent,
  findMountForPath,
  pathComponents,
  resolveDiagnosticGetfaclPath,
} from './preflight-diagnostics';
import {
  createArtifactSnapshot,
  createCommonArtifactSnapshot,
  copySparseFileWithRsync,
  type CloudHypervisorArtifactSnapshot,
  type CloudHypervisorArtifactSnapshotSources,
  type CloudHypervisorCommonArtifactSnapshot,
  type CloudHypervisorCommonArtifactSnapshotSources,
} from './artifact-snapshot';
import {
  assertDigest,
  assertTrustedAncestorChain,
  assertTrustedHostTool,
  assertTrustedRegularFile,
  calculateSha256,
  type CloudHypervisorArtifactTrustDependencies,
  hasCompleteArtifactDigests,
  parsePositiveUid,
  resolveTrustedOperatorUid,
} from './artifact-trust';
import {
  HostPreflightReporter, type HostPreflightProgress,
} from './host-preflight-progress';
import {
  checkArtifactBinaryTrust,
  createPreflightArtifactSnapshot,
  hasPrimaryRootfs,
  verifyManifestAttestation,
  verifyPreflightArtifactBinaries,
  verifyPreflightGuestDigests,
} from './preflight-artifact-trust';
import {
  checkPreflightHostPolicy, defaultHostPolicyDependencies, resolvePreflightHostTools,
} from './preflight-host-policy';
import { checkArtifactVersions, runVersion } from './preflight-version-probe';

export {
  parseCloudHypervisorVersion, parseVirtiofsdVersion, VIRTIOFSD_RELEASE_VERSION,
} from './preflight-version-probe';

/**
 * Fail-closed host and artifact validation for the Cloud Hypervisor v53.0
 * runtime. Trust checks cover absolute paths, root/operator-owned
 * non-writable regular files, trusted ancestor
 * directories, digest pinning, PATH-resolved but ownership-verified host
 * tools) so both VMM backends share the same fail-closed posture.
 *
 * Cloud Hypervisor has no jailer-equivalent process. AWF instead requires
 * the pinned v1.13.3 virtiofsd sibling used for directory exports, while
 * `src/cloud-hypervisor/launcher.ts` builds an equivalent
 * network-namespace-join + privilege-drop + Landlock/seccomp launch using
 * the `setpriv` tool resolved here, and `src/cloud-hypervisor/manager.ts`
 * stages artifacts into a private, non-world-readable run directory.
 */

export interface CloudHypervisorPreflightDependencies extends CloudHypervisorArtifactTrustDependencies {
  hostPreflightReporter?: HostPreflightReporter;
  onHostPreflight?: (progress: HostPreflightProgress) => void;
  platform: NodeJS.Platform;
  arch: string;
  runVersion(binaryPath: string): Promise<string>;
  readFile(filePath: string): Promise<string>;
  createArtifactSnapshot(
    sources: CloudHypervisorArtifactSnapshotSources,
    copySparseFile: (source: string, destination: string) => Promise<void>,
  ): Promise<CloudHypervisorArtifactSnapshot>;
  createCommonArtifactSnapshot(
    sources: CloudHypervisorCommonArtifactSnapshotSources,
    copySparseFile: (source: string, destination: string) => Promise<void>,
  ): Promise<CloudHypervisorCommonArtifactSnapshot>;
  copySparseFile(rsyncBinaryPath: string, source: string, destination: string): Promise<void>;
  removeArtifactSnapshot(directory: string): Promise<void>;
  verifyManifestAttestation(
    ghBinaryPath: string,
    manifestPath: string,
    bundlePath: string,
  ): Promise<void>;
  assertToolAvailable(tool: string): Promise<string>;
  assertHostPolicy(report?: HostPreflightReporter): Promise<2>;
  assertDockerInfrastructure(dockerBinaryPath: string, report?: HostPreflightReporter): Promise<void>;
  /** Resolves the group ID that owns `/dev/kvm`, so the launcher can retain
   * exactly that supplementary group instead of the full operator group set. */
  resolveKvmGid(): Promise<number>;
}

export type CloudHypervisorHostToolPaths = Readonly<{
  getfacl: string;
  getent: string;
  groupdel: string;
  id: string;
  ip: string;
  docker: string;
  nft: string;
  sysctl: string;
  /** util-linux `flock`, used to serialize durable microVM network reservations. */
  flock: string;
  mke2fs: string;
  debugfs: string;
  e2fsck: string;
  rsync: string;
  mount: string;
  umount: string;
  /**
   * util-linux `setpriv`, used by the launcher to drop to the non-root
   * operator uid/gid and clear capabilities/groups after joining the
   * per-run network namespace (there is no jailer-equivalent process to do
   * this for Cloud Hypervisor). See `src/cloud-hypervisor/launcher.ts`.
   */
  setpriv: string;
  setfacl: string;
  useradd: string;
  userdel: string;
}>;

const defaultDependencies: CloudHypervisorPreflightDependencies = {
  ...defaultHostPolicyDependencies,
  platform: process.platform,
  arch: process.arch,
  uid: -1,
  access: fs.access,
  lstat: fs.lstat,
  runVersion,
  sha256: calculateSha256,
  readFile: async (filePath) => fs.readFile(filePath, 'utf8'),
  createArtifactSnapshot: createArtifactSnapshot,
  createCommonArtifactSnapshot,
  copySparseFile: copySparseFileWithRsync,
  removeArtifactSnapshot: async (directory) => {
    await fs.rm(directory, { recursive: true, force: true });
  },
  verifyManifestAttestation,
};

export {
  buildExecutionFailureDiagnostics,
  describeAcl,
  describeMountForPath,
  describePathComponent,
  findMountForPath,
  pathComponents,
  resolveDiagnosticGetfaclPath,
  copySparseFileWithRsync,
  createArtifactSnapshot,
  assertDigest,
  assertTrustedAncestorChain,
  assertTrustedHostTool,
  assertTrustedRegularFile,
  calculateSha256,
  hasCompleteArtifactDigests,
  parsePositiveUid,
  resolveTrustedOperatorUid,
};
export type {
  CloudHypervisorArtifactSnapshot,
  CloudHypervisorArtifactSnapshotSources,
};

/** @internal Exposed only for focused host-probe tests. */
export const cloudHypervisorPreflightTestHelpers = {
  defaultDependencies,
  createArtifactSnapshot,
};

export interface CloudHypervisorPreflightResult {
  version: string;
  cloudHypervisorBinary: string;
  virtiofsdBinary: string;
  kernelPath: string;
  rootfsPath: string;
  supervisorPath: string;
  artifactSnapshotDirectory: string;
  artifactDigests: Required<CloudHypervisorArtifactDigests>;
  tools: CloudHypervisorHostToolPaths;
  cgroupVersion: 2;
  /** Group ID that owns `/dev/kvm`, retained as the launcher's sole supplementary group. */
  kvmGid: number;
}

export type CloudHypervisorCommonPreflightResult =
  Omit<CloudHypervisorPreflightResult, 'rootfsPath' | 'artifactDigests'> & {
    artifactDigests: Omit<Required<CloudHypervisorArtifactDigests>, 'rootfs'>;
  };

export const CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS = 3;

type CloudHypervisorReadinessStage =
  | 'guest-network-readiness'
  | 'guest-connectivity';

/** @internal Structured sentinel used to permit only pre-agent boot retries. */
// ts-prune-ignore-next
export class CloudHypervisorRetryableReadinessError extends Error {
  readonly code = 'CLOUD_HYPERVISOR_RETRYABLE_READINESS';
  readonly retryable = true;
  diagnosticDirectories: readonly string[] = [];

  constructor(
    readonly stage: CloudHypervisorReadinessStage,
    readonly bootAttempt: number,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `Cloud Hypervisor retryable readiness failure ` +
      `(stage=${stage}, boot attempt=${bootAttempt}/${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}): ${detail}`,
    );
    this.name = 'CloudHypervisorRetryableReadinessError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }

  attachDiagnostics(directories: readonly string[], exhausted: boolean): void {
    this.diagnosticDirectories = [...directories];
    if (exhausted) {
      this.message +=
        `; boot recovery exhausted after ${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS} attempts` +
        (directories.length > 0 ? `; diagnostics: ${directories.join(', ')}` : '');
    }
  }
}

/**
 * Fail-closed host and artifact validation for Cloud Hypervisor v53.0.
 *
 * This checks Linux/KVM host requirements, trusted artifact
 * ownership/permissions, pinned version, and pinned digests,
 * adapted for Cloud Hypervisor's single-binary VMM (no jailer).
 */
export async function runCloudHypervisorPreflight(
  config: CloudHypervisorOptions,
  overrides: Partial<CloudHypervisorPreflightDependencies> = {},
): Promise<CloudHypervisorPreflightResult> {
  const result = await runPreflight(config, overrides, false);
  if (!('rootfsPath' in result)) throw new Error('Primary Cloud Hypervisor rootfs is missing');
  return result;
}

export async function runCloudHypervisorCommonPreflight(
  config: CloudHypervisorOptions,
  overrides: Partial<CloudHypervisorPreflightDependencies> = {},
): Promise<CloudHypervisorCommonPreflightResult> {
  return runPreflight(config, overrides, true);
}

function runPreflight(
  config: CloudHypervisorOptions,
  overrides: Partial<CloudHypervisorPreflightDependencies>,
  commonOnly: true,
): Promise<CloudHypervisorCommonPreflightResult>;
function runPreflight(
  config: CloudHypervisorOptions,
  overrides: Partial<CloudHypervisorPreflightDependencies>,
  commonOnly: false,
): Promise<CloudHypervisorPreflightResult>;
async function runPreflight(
  config: CloudHypervisorOptions,
  overrides: Partial<CloudHypervisorPreflightDependencies>,
  commonOnly: boolean,
): Promise<CloudHypervisorCommonPreflightResult | CloudHypervisorPreflightResult> {
  const report = overrides.hostPreflightReporter ?? new HostPreflightReporter(
    'bounded-runtime', overrides.onHostPreflight, undefined,
    { phase: 'preflight', profile: commonOnly ? 'common' : 'primary' },
  );
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
    uid: await report.check('operator-identity', () => overrides.uid ?? resolveTrustedOperatorUid()),
  };
  const artifactConfig = { ...config, commonOnly };
  const virtiofsdBinary = await checkArtifactBinaryTrust(report, dependencies, artifactConfig);
  const hostTools = await resolvePreflightHostTools(report, dependencies);
  const snapshot = await createPreflightArtifactSnapshot(
    report, dependencies, { ...artifactConfig, virtiofsdBinary, tools: hostTools },
  );
  try {
    const artifactDigests = await verifyPreflightArtifactBinaries(
      report, dependencies, { ...artifactConfig, virtiofsdBinary, snapshot },
    );
    const version = await checkArtifactVersions(report, dependencies, snapshot);
    await verifyPreflightGuestDigests(report, dependencies, { commonOnly, snapshot, artifactDigests });

    // Artifact trust must be established before any host-capability error can
    // trigger the supported fallback to Docker.
    const { dockerBinaryPath, kvmGid, cgroupVersion } =
      await checkPreflightHostPolicy(report, dependencies);
    const tools: CloudHypervisorHostToolPaths = { ...hostTools, docker: dockerBinaryPath };

    const commonResult: CloudHypervisorCommonPreflightResult = {
      version,
      cloudHypervisorBinary: snapshot.cloudHypervisorBinary,
      virtiofsdBinary: snapshot.virtiofsdBinary,
      kernelPath: snapshot.kernelPath,
      supervisorPath: snapshot.supervisorPath,
      artifactSnapshotDirectory: snapshot.directory,
      artifactDigests: {
        cloudHypervisor: artifactDigests.cloudHypervisor,
        virtiofsd: artifactDigests.virtiofsd,
        kernel: artifactDigests.kernel,
        supervisor: artifactDigests.supervisor,
      },
      tools,
      cgroupVersion,
      kvmGid,
    };
    if (commonOnly) return commonResult;
    if (!hasPrimaryRootfs(snapshot)) throw new Error('Primary Cloud Hypervisor rootfs snapshot is missing');
    return {
      ...commonResult, rootfsPath: snapshot.rootfsPath,
      artifactDigests: { ...commonResult.artifactDigests, rootfs: artifactDigests.rootfs },
    };
  } catch (error) {
    await dependencies.removeArtifactSnapshot(snapshot.directory);
    throw error;
  }
}
