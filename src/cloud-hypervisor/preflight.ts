import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  CLOUD_HYPERVISOR_RELEASE_VERSION,
  type CloudHypervisorArtifactDigests,
  type CloudHypervisorOptions,
} from '../types/runtime-options';
import {
  CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
  CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
  artifactDigestsFromManifest,
  assertArtifactBasenames,
  parseCloudHypervisorArtifactManifest,
} from './artifact-manifest';
import { CloudHypervisorUnsupportedHostError } from './errors';
import { logger } from '../logger';
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
  copySparseFileWithRsync,
  type CloudHypervisorArtifactSnapshot,
  type CloudHypervisorArtifactSnapshotSources,
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

/**
 * Fail-closed host and artifact validation for the Cloud Hypervisor v53.0
 * runtime. Trust checks cover absolute paths, root/operator-owned
 * non-writable regular files, trusted ancestor
 * directories, digest pinning, PATH-resolved but ownership-verified host
 * tools) so both VMM backends share the same fail-closed posture.
 *
 * Cloud Hypervisor has no jailer-equivalent process. AWF instead requires
 * the pinned v1.10.0 virtiofsd sibling used for directory exports, while
 * `src/cloud-hypervisor/launcher.ts` builds an equivalent
 * network-namespace-join + privilege-drop + Landlock/seccomp launch using
 * the `setpriv` tool resolved here, and `src/cloud-hypervisor/manager.ts`
 * stages artifacts into a private, non-world-readable run directory.
 */

export interface CloudHypervisorPreflightDependencies extends CloudHypervisorArtifactTrustDependencies {
  platform: NodeJS.Platform;
  arch: string;
  runVersion(binaryPath: string): Promise<string>;
  readFile(filePath: string): Promise<string>;
  createArtifactSnapshot(
    sources: CloudHypervisorArtifactSnapshotSources,
    copySparseFile: (source: string, destination: string) => Promise<void>,
  ): Promise<CloudHypervisorArtifactSnapshot>;
  copySparseFile(rsyncBinaryPath: string, source: string, destination: string): Promise<void>;
  removeArtifactSnapshot(directory: string): Promise<void>;
  verifyManifestAttestation(
    ghBinaryPath: string,
    manifestPath: string,
    bundlePath: string,
  ): Promise<void>;
  assertToolAvailable(tool: string): Promise<string>;
  assertHostPolicy(): Promise<2>;
  assertDockerInfrastructure(dockerBinaryPath: string): Promise<void>;
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

const CLOUD_HYPERVISOR_HOST_TOOLS: (keyof CloudHypervisorHostToolPaths)[] = [
  'getent', 'getfacl', 'groupdel', 'id', 'ip', 'nft', 'sysctl', 'flock', 'mke2fs', 'debugfs', 'e2fsck',
  'rsync', 'mount', 'umount', 'setfacl', 'setpriv', 'useradd', 'userdel',
];

async function versionProbeExecutionError(
  binaryPath: string,
  details: string,
  code?: string,
): Promise<Error> {
  let message: string;
  if (code === 'ENOENT') {
    message =
      `Required external binary "${binaryPath}" is unavailable: the binary or its interpreter ` +
      `was not found${details ? ` (${details})` : ''}`;
  } else if (code === 'EACCES') {
    message =
      `Permission denied executing "${binaryPath} --version"; verify path traversal permissions ` +
      `and that the artifact is on an exec-capable mount${details ? `: ${details}` : ''}`;
    message += await buildExecutionFailureDiagnostics(binaryPath);
  } else {
    message =
      `Unable to execute required external binary "${binaryPath} --version"; verify the trusted ` +
      `artifact exists, is executable, and is complete${details ? `: ${details}` : ''}`;
    message += await buildExecutionFailureDiagnostics(binaryPath);
  }
  return Object.assign(new Error(message), code ? { code } : {});
}

const defaultDependencies: CloudHypervisorPreflightDependencies = {
  platform: process.platform,
  arch: process.arch,
  uid: -1,
  access: fs.access,
  lstat: fs.lstat,
  runVersion: async (binaryPath) => {
    let result;
    try {
      result = await execa(binaryPath, ['--version'], {
        reject: false,
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const code = error && typeof error === 'object' &&
        typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
      const details = [
        code ? `code=${code}` : '',
        error instanceof Error ? error.message : String(error),
      ].filter(Boolean).join('; ');
      throw await versionProbeExecutionError(
        binaryPath,
        details,
        code,
      );
    }
    if (result.exitCode == null && !result.signal) {
      const executionError = result as typeof result & {
        code?: unknown;
        shortMessage?: unknown;
      };
      const codeValue = typeof executionError.code === 'string' ? executionError.code : undefined;
      const code = codeValue ? `code=${codeValue}` : '';
      const shortMessage = typeof executionError.shortMessage === 'string'
        ? executionError.shortMessage
        : '';
      const details = [code, shortMessage, result.stderr.trim()].filter(Boolean).join('; ');
      throw await versionProbeExecutionError(binaryPath, details, codeValue);
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const signalCode = result.signal ?? null;
      const exitCode = result.exitCode ?? null;
      const termination = signalCode
        ? `terminated by signal ${signalCode}`
        : `exited with code ${exitCode}`;
      throw new Error(
        `"${binaryPath} --version" ${termination} ` +
        `(exitCode=${exitCode}, signalCode=${signalCode})${stderr ? `: ${stderr}` : ''}`,
      );
    }
    return `${result.stdout}\n${result.stderr}`.trim();
  },
  sha256: calculateSha256,
  readFile: async (filePath) => fs.readFile(filePath, 'utf8'),
  createArtifactSnapshot: createArtifactSnapshot,
  copySparseFile: copySparseFileWithRsync,
  removeArtifactSnapshot: async (directory) => {
    await fs.rm(directory, { recursive: true, force: true });
  },
  verifyManifestAttestation: async (ghBinaryPath, manifestPath, bundlePath) => {
    const result = await execa(ghBinaryPath, [
      'attestation',
      'verify',
      manifestPath,
      '--repo',
      CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
      '--bundle',
      bundlePath,
      '--signer-workflow',
      CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
      '--deny-self-hosted-runners',
    ], {
      reject: false,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub artifact attestation verification failed with code ${result.exitCode}: ${
          result.stderr.trim()
        }`,
      );
    }
  },
  assertToolAvailable: async (tool) => {
    const searchPath = process.env.PATH ?? '';
    for (const directory of searchPath.split(path.delimiter)) {
      if (!directory) continue;
      try {
        const candidate = path.join(directory, tool);
        await assertTrustedHostTool(tool, candidate);
        return candidate;
      } catch {
        // Continue searching the bounded host PATH.
      }
    }
    throw new Error(`required trusted host tool "${tool}" was not found on PATH`);
  },
  assertHostPolicy: async () => {
    if (process.getuid?.() !== 0) {
      throw new CloudHypervisorUnsupportedHostError(
        'Cloud Hypervisor network setup requires root; invoke awf through sudo from a non-root account',
      );
    }
    try {
      await fs.access('/proc/sys/net/ipv4/ip_forward', constants.R_OK);
      await fs.access('/proc/sys/net/ipv6/conf/all/disable_ipv6', constants.R_OK);
      await fs.access('/proc/sys/kernel/seccomp/actions_avail', constants.R_OK);
    } catch (error) {
      throw new CloudHypervisorUnsupportedHostError(
        'host kernel policy does not expose required network namespace and seccomp controls: ' +
        `${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    try {
      await fs.access('/sys/fs/cgroup/cgroup.controllers', constants.R_OK);
      return 2;
    } catch (error) {
      // Cloud Hypervisor's launcher manages an explicit memory/CPU/PID
      // cgroup for the launched process (see `src/cloud-hypervisor/launcher.ts`
      // `CloudHypervisorCgroup`), which requires the cgroup v2 unified
      // hierarchy's `cgroup.subtree_control` delegation model. A cgroup v1
      // fallback would need separate per-controller mount points
      // (`memory`, `cpu,cpuacct`, `pids`) that this launcher does not
      // manage, so it is rejected explicitly rather than silently
      // constructing a broken cgroup. GitHub-hosted Ubuntu runners (the
      // only supported host) always run cgroup v2.
      throw new CloudHypervisorUnsupportedHostError(
        'Cloud Hypervisor requires the cgroup v2 unified hierarchy ' +
        '(/sys/fs/cgroup/cgroup.controllers); cgroup v1-only hosts are not supported: ' +
        `${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  },
  assertDockerInfrastructure: async (dockerBinaryPath) => {
    for (const args of [['info'], ['compose', 'version']] as const) {
      const result = await execa(dockerBinaryPath, [...args], {
        reject: false,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `${dockerBinaryPath} ${args.join(' ')} failed with code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
    }
  },
  resolveKvmGid: async () => {
    const stat = await fs.stat('/dev/kvm');
    return stat.gid;
  },
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

export const CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS = 3;

/**
 * Number of attempts for the post-digest-verification `--version` probe.
 * The staged artifact's content is already digest-verified before this runs,
 * so a probe failure here reflects a transient host/exec hiccup (e.g. a
 * momentary I/O error copying/executing the just-staged binary) rather than
 * a corrupt or wrong artifact. Retrying a couple of times avoids failing an
 * entire run over a fleeting condition. See gh-aw-firewall#8767.
 */
const CLOUD_HYPERVISOR_VERSION_PROBE_ATTEMPTS = 3;
const CLOUD_HYPERVISOR_VERSION_PROBE_RETRY_DELAY_MS = 250;

/**
 * Error codes indicating a deterministic, non-transient version-probe
 * failure: the binary is missing, not a regular file, or not executable.
 * These will not resolve on retry, so they are allowed to fail closed
 * immediately instead of paying the retry delay. The default `runVersion`
 * attaches a structured `code` property when the underlying spawn failure
 * carries one (see its `Object.assign(new Error(...), { code })` above);
 * the `code=XXX` message fragment is used as a fallback for callers that
 * inject a custom `runVersion` throwing a plain `Error`.
 */
const CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'ENOEXEC',
]);
const CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODE_PATTERN = /\bcode=(ENOENT|EACCES|EISDIR|ENOTDIR|ENOEXEC)\b/;

function isPermanentVersionProbeError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODE_PATTERN.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `dependencies.runVersion` with a small bounded retry for transient
 * execution failures. The binary's digest has already been verified to
 * match the trusted manifest by the time this is called, so any rejection
 * here is an execution-environment problem, not an artifact integrity
 * problem, and is generally safe to retry. Deterministic failures (missing
 * file, permission denied, etc.) are not retried since they would not
 * resolve on their own.
 */
async function runVersionWithRetry(
  dependencies: Pick<CloudHypervisorPreflightDependencies, 'runVersion'>,
  binaryPath: string,
  attempts: number = CLOUD_HYPERVISOR_VERSION_PROBE_ATTEMPTS,
  retryDelayMs: number = CLOUD_HYPERVISOR_VERSION_PROBE_RETRY_DELAY_MS,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await dependencies.runVersion(binaryPath);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && !isPermanentVersionProbeError(error)) {
        logger.warn(
          `Cloud Hypervisor version probe failed for "${binaryPath}" ` +
          `(attempt ${attempt}/${attempts}); retrying: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(retryDelayMs);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

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
 * Parses a `cloud-hypervisor --version` output like `cloud-hypervisor v53.0`
 * (also accepts the plain `v53.0`/`53.0` forms some builds emit).
 */
export function parseCloudHypervisorVersion(output: string): string {
  const match = output.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  if (!match) {
    throw new Error(`Could not parse Cloud Hypervisor version from: ${JSON.stringify(output)}`);
  }
  return match[1];
}

export const VIRTIOFSD_RELEASE_VERSION = '1.10.0';

export function parseVirtiofsdVersion(output: string): string {
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match) {
    throw new Error(`Could not parse virtiofsd version from: ${JSON.stringify(output)}`);
  }
  return match[1];
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
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
    uid: overrides.uid ?? resolveTrustedOperatorUid(),
  };
  if (!config.kernelPath || !config.rootfsPath || !config.supervisorPath) {
    throw new Error(
      'Cloud Hypervisor requires guest kernel, rootfs, and supervisor artifact paths',
    );
  }
  const developmentBypass = config.developmentAllowUnattestedArtifacts === true;
  if (
    developmentBypass &&
    process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS !== '1'
  ) {
    throw new Error(
      'Cloud Hypervisor development artifact bypass requires ' +
      'AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1',
    );
  }
  if (
    !developmentBypass &&
    (!config.artifactManifestPath ||
      !config.artifactManifestBundlePath ||
      !config.artifactReleaseTag)
  ) {
    throw new Error(
      'Cloud Hypervisor requires an artifact manifest, attestation bundle, and expected release tag',
    );
  }

  await assertTrustedRegularFile(
    'Cloud Hypervisor binary',
    config.cloudHypervisorBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  );
  const virtiofsdBinary = path.join(path.dirname(config.cloudHypervisorBinary), 'virtiofsd');
  await assertTrustedRegularFile(
    'virtiofsd binary',
    virtiofsdBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  );

  const tools = {} as Record<keyof CloudHypervisorHostToolPaths, string>;
  for (const tool of CLOUD_HYPERVISOR_HOST_TOOLS) {
    try {
      tools[tool] = await dependencies.assertToolAvailable(tool);
    } catch (error) {
      throw new Error(
        `Cloud Hypervisor requires host tool "${tool}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await assertTrustedRegularFile(
    'Cloud Hypervisor guest kernel',
    config.kernelPath,
    constants.R_OK,
    dependencies,
  );
  await assertTrustedRegularFile(
    'Cloud Hypervisor rootfs',
    config.rootfsPath,
    constants.R_OK,
    dependencies,
  );
  await assertTrustedRegularFile(
    'Cloud Hypervisor guest supervisor',
    config.supervisorPath,
    constants.R_OK,
    dependencies,
  );
  if (!developmentBypass) {
    await assertTrustedRegularFile(
      'Cloud Hypervisor artifact manifest',
      config.artifactManifestPath!,
      constants.R_OK,
      dependencies,
    );
    await assertTrustedRegularFile(
      'Cloud Hypervisor artifact attestation bundle',
      config.artifactManifestBundlePath!,
      constants.R_OK,
      dependencies,
    );
  }

  const snapshot = await dependencies.createArtifactSnapshot(
    {
      cloudHypervisorBinary: config.cloudHypervisorBinary,
      virtiofsdBinary,
      kernelPath: config.kernelPath,
      rootfsPath: config.rootfsPath,
      supervisorPath: config.supervisorPath,
      ...(!developmentBypass
        ? {
          manifestPath: config.artifactManifestPath!,
          bundlePath: config.artifactManifestBundlePath!,
        }
        : {}),
    },
    (source, destination) =>
      dependencies.copySparseFile(tools.rsync, source, destination),
  );
  try {
    let artifactDigests: Required<CloudHypervisorArtifactDigests>;
    if (developmentBypass) {
      if (!hasCompleteArtifactDigests(config.sha256)) {
      throw new Error(
        'Cloud Hypervisor development artifact bypass requires SHA-256 digests for all five artifacts',
      );
      }
      artifactDigests = config.sha256;
    } else {
      const ghBinaryPath = await dependencies.assertToolAvailable('gh');
      await dependencies.verifyManifestAttestation(
      ghBinaryPath,
      snapshot.manifestPath!,
      snapshot.bundlePath!,
      );
      const manifest = parseCloudHypervisorArtifactManifest(
      await dependencies.readFile(snapshot.manifestPath!),
      config.artifactReleaseTag!,
      );
      assertArtifactBasenames(manifest, {
      cloudHypervisor: config.cloudHypervisorBinary,
      virtiofsd: virtiofsdBinary,
      kernel: config.kernelPath,
      rootfs: config.rootfsPath,
      supervisor: config.supervisorPath,
      });
      artifactDigests = artifactDigestsFromManifest(manifest);
    }
    await assertDigest(
      'Cloud Hypervisor binary',
      snapshot.cloudHypervisorBinary,
      artifactDigests.cloudHypervisor,
      dependencies,
    );
    await assertDigest(
      'virtiofsd binary',
      snapshot.virtiofsdBinary,
      artifactDigests.virtiofsd,
      dependencies,
    );

    const version = parseCloudHypervisorVersion(
      await runVersionWithRetry(dependencies, snapshot.cloudHypervisorBinary),
    );
    if (version !== CLOUD_HYPERVISOR_RELEASE_VERSION) {
      throw new Error(
      `Cloud Hypervisor is pinned to v${CLOUD_HYPERVISOR_RELEASE_VERSION}; found v${version}`,
      );
    }
    const virtiofsdVersion = parseVirtiofsdVersion(
      await runVersionWithRetry(dependencies, snapshot.virtiofsdBinary),
    );
    if (virtiofsdVersion !== VIRTIOFSD_RELEASE_VERSION) {
      throw new Error(
      `virtiofsd is pinned to v${VIRTIOFSD_RELEASE_VERSION}; found v${virtiofsdVersion}`,
      );
    }

    await assertDigest(
      'Cloud Hypervisor guest kernel',
      snapshot.kernelPath,
      artifactDigests.kernel,
      dependencies,
    );
    await assertDigest(
      'Cloud Hypervisor rootfs',
      snapshot.rootfsPath,
      artifactDigests.rootfs,
      dependencies,
    );
    await assertDigest(
      'Cloud Hypervisor guest supervisor',
      snapshot.supervisorPath,
      artifactDigests.supervisor,
      dependencies,
    );

    // Artifact trust must be established before any host-capability error can
    // trigger the supported fallback to Docker.
    if (dependencies.platform !== 'linux') {
      throw new CloudHypervisorUnsupportedHostError(
        `Cloud Hypervisor requires Linux with KVM; found ${dependencies.platform}`,
      );
    }
    if (dependencies.arch !== 'x64') {
      throw new CloudHypervisorUnsupportedHostError(
        `Cloud Hypervisor is supported only on x86_64 GitHub-hosted runners; found Node architecture ${dependencies.arch}`,
      );
    }
    try {
      await dependencies.access('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new CloudHypervisorUnsupportedHostError(
        'Cloud Hypervisor requires readable and writable /dev/kvm: ' +
        `${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    const kvmGid = await dependencies.resolveKvmGid();
    let cgroupVersion: 2;
    try {
      cgroupVersion = await dependencies.assertHostPolicy();
    } catch (error) {
      throw error instanceof CloudHypervisorUnsupportedHostError
        ? error
        : new CloudHypervisorUnsupportedHostError(
          `Cloud Hypervisor host policy is unsupported: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
    }
    let dockerBinaryPath: string;
    try {
      dockerBinaryPath = await dependencies.assertToolAvailable('docker');
    } catch (error) {
      throw new Error(
        'Cloud Hypervisor requires host tool "docker": ' +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await dependencies.assertDockerInfrastructure(dockerBinaryPath);

    return {
      version,
      cloudHypervisorBinary: snapshot.cloudHypervisorBinary,
      virtiofsdBinary: snapshot.virtiofsdBinary,
      kernelPath: snapshot.kernelPath,
      rootfsPath: snapshot.rootfsPath,
      supervisorPath: snapshot.supervisorPath,
      artifactSnapshotDirectory: snapshot.directory,
      artifactDigests,
      tools,
      cgroupVersion,
      kvmGid,
    };
  } catch (error) {
    await dependencies.removeArtifactSnapshot(snapshot.directory);
    throw error;
  }
}
