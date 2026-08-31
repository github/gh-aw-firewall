import { createHash } from 'crypto';
import { createReadStream, constants, promises as fs } from 'fs';
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

export interface CloudHypervisorPreflightDependencies {
  platform: NodeJS.Platform;
  arch: string;
  uid: number;
  access(filePath: string, mode: number): Promise<void>;
  lstat(filePath: string): Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    uid: number;
  }>;
  runVersion(binaryPath: string): Promise<string>;
  sha256(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<string>;
  createArtifactSnapshot(
    sources: CloudHypervisorArtifactSnapshotSources,
  ): Promise<CloudHypervisorArtifactSnapshot>;
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

export interface CloudHypervisorArtifactSnapshotSources {
  cloudHypervisorBinary: string;
  virtiofsdBinary: string;
  kernelPath: string;
  rootfsPath: string;
  supervisorPath: string;
  manifestPath?: string;
  bundlePath?: string;
}

export interface CloudHypervisorArtifactSnapshot extends CloudHypervisorArtifactSnapshotSources {
  directory: string;
}

const CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT =
  '/run/awf-cloud-hypervisor/trusted-artifacts';
const CLOUD_HYPERVISOR_HOST_TOOLS: (keyof CloudHypervisorHostToolPaths)[] = [
  'getent', 'getfacl', 'groupdel', 'id', 'ip', 'nft', 'sysctl', 'flock', 'mke2fs', 'debugfs', 'e2fsck',
  'rsync', 'mount', 'umount', 'setfacl', 'setpriv', 'useradd', 'userdel',
];

const defaultDependencies: CloudHypervisorPreflightDependencies = {
  platform: process.platform,
  arch: process.arch,
  uid: -1,
  access: fs.access,
  lstat: fs.lstat,
  runVersion: async (binaryPath) => {
    const result = await execa(binaryPath, ['--version'], {
      reject: false,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `"${binaryPath} --version" exited with code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return `${result.stdout}\n${result.stderr}`.trim();
  },
  sha256: calculateSha256,
  readFile: async (filePath) => fs.readFile(filePath, 'utf8'),
  createArtifactSnapshot: createArtifactSnapshot,
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
      throw new Error(
        'Cloud Hypervisor network setup requires root; invoke awf through sudo from a non-root account',
      );
    }
    try {
      await fs.access('/proc/sys/net/ipv4/ip_forward', constants.R_OK);
      await fs.access('/proc/sys/net/ipv6/conf/all/disable_ipv6', constants.R_OK);
      await fs.access('/proc/sys/kernel/seccomp/actions_avail', constants.R_OK);
    } catch (error) {
      throw new Error(
        'host kernel policy does not expose required network namespace and seccomp controls: ' +
        `${error instanceof Error ? error.message : String(error)}`,
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
      throw new Error(
        'Cloud Hypervisor requires the cgroup v2 unified hierarchy ' +
        '(/sys/fs/cgroup/cgroup.controllers); cgroup v1-only hosts are not supported: ' +
        `${error instanceof Error ? error.message : String(error)}`,
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

/** @internal Exposed only for focused host-probe tests. */
export const cloudHypervisorPreflightTestHelpers = { defaultDependencies };

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

async function createArtifactSnapshot(
  sources: CloudHypervisorArtifactSnapshotSources,
): Promise<CloudHypervisorArtifactSnapshot> {
  await fs.mkdir(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, {
    recursive: true,
    mode: 0o711,
  });
  await fs.chmod(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 0o711);
  const directory = await fs.mkdtemp(
    path.join(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 'run-'),
  );
  const copy = async (
    source: string,
    name: string,
    mode: number,
  ): Promise<string> => {
    const destination = path.join(directory, name);
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, mode);
    return destination;
  };
  try {
    const snapshot: CloudHypervisorArtifactSnapshot = {
      directory,
      cloudHypervisorBinary: await copy(
        sources.cloudHypervisorBinary,
        'cloud-hypervisor',
        0o555,
      ),
      virtiofsdBinary: await copy(sources.virtiofsdBinary, 'virtiofsd', 0o555),
      kernelPath: await copy(sources.kernelPath, 'vmlinux.bin', 0o444),
      rootfsPath: await copy(sources.rootfsPath, 'rootfs.ext4', 0o444),
      supervisorPath: await copy(sources.supervisorPath, 'awf-supervisor', 0o555),
    };
    if (sources.manifestPath) {
      snapshot.manifestPath = await copy(sources.manifestPath, 'manifest.json', 0o444);
    }
    if (sources.bundlePath) {
      snapshot.bundlePath = await copy(
        sources.bundlePath,
        'manifest.sigstore.jsonl',
        0o444,
      );
    }
    await fs.chmod(directory, 0o555);
    return snapshot;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
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

async function assertTrustedHostTool(label: string, filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`host tool "${label}" path must be absolute: ${filePath}`);
  }
  const { root } = path.parse(filePath);
  const segments = filePath.slice(root.length).split('/').filter(Boolean);
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const stat = await fs.lstat(ancestor);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || stat.uid !== 0) {
      throw new Error(`host tool "${label}" has an untrusted parent directory: ${ancestor}`);
    }
  }
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o022) !== 0 ||
    stat.uid !== 0
  ) {
    throw new Error(`host tool "${label}" must be a root-owned non-writable regular file: ${filePath}`);
  }
  await fs.access(filePath, constants.X_OK);
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

export async function calculateSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function assertTrustedRegularFile(
  label: string,
  filePath: string,
  accessMode: number,
  dependencies: CloudHypervisorPreflightDependencies,
): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute: ${filePath}`);
  }
  await assertTrustedAncestorChain(label, filePath, dependencies);
  let stat;
  try {
    stat = await dependencies.lstat(filePath);
  } catch (error) {
    throw new Error(
      `${label} is unavailable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and not a symbolic link: ${filePath}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable: ${filePath}`);
  }
  if (stat.uid !== 0 && stat.uid !== dependencies.uid) {
    throw new Error(
      `${label} must be owned by root or uid ${dependencies.uid}; found uid ${stat.uid}: ${filePath}`,
    );
  }
  try {
    await dependencies.access(filePath, accessMode);
  } catch (error) {
    throw new Error(
      `${label} does not have the required host access: ${filePath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parsePositiveUid(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

function resolveTrustedOperatorUid(): number {
  return parsePositiveUid(process.env.SUDO_UID) ?? (process.getuid?.() ?? -1);
}

async function assertTrustedAncestorChain(
  label: string,
  filePath: string,
  dependencies: CloudHypervisorPreflightDependencies,
): Promise<void> {
  const { root } = path.parse(filePath);
  const segments = filePath.slice(root.length).split('/').filter((segment) => segment.length > 0);
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const stat = await dependencies.lstat(ancestor);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${label} parent directory must not be a symbolic link: ${ancestor}`,
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(
        `${label} parent directory must not be group- or world-writable: ${ancestor}`,
      );
    }
    if (stat.uid !== 0 && stat.uid !== dependencies.uid) {
      throw new Error(
        `${label} parent directory must be owned by root or uid ${dependencies.uid}; ` +
        `found uid ${stat.uid}: ${ancestor}`,
      );
    }
  }
}

async function assertDigest(
  label: string,
  filePath: string,
  expected: string | undefined,
  dependencies: CloudHypervisorPreflightDependencies,
): Promise<void> {
  if (!expected) return;
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw new Error(`${label} SHA-256 must contain exactly 64 hexadecimal characters`);
  }

  const actual = await dependencies.sha256(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected.toLowerCase()}, got ${actual.toLowerCase()}`,
    );
  }
}

function hasCompleteArtifactDigests(
  digests: CloudHypervisorArtifactDigests | undefined,
): digests is Required<CloudHypervisorArtifactDigests> {
  return Boolean(
    digests?.cloudHypervisor &&
    digests.virtiofsd &&
    digests.kernel &&
    digests.rootfs &&
    digests.supervisor,
  );
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
  if (dependencies.platform !== 'linux') {
    throw new Error(`Cloud Hypervisor requires Linux with KVM; found ${dependencies.platform}`);
  }
  if (dependencies.arch !== 'x64') {
    throw new Error(
      `Cloud Hypervisor is supported only on x86_64 GitHub-hosted runners; found Node architecture ${dependencies.arch}`,
    );
  }
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

  try {
    await dependencies.access('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch (error) {
    throw new Error(
      'Cloud Hypervisor requires readable and writable /dev/kvm: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const kvmGid = await dependencies.resolveKvmGid();
  const cgroupVersion = await dependencies.assertHostPolicy();
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

  const snapshot = await dependencies.createArtifactSnapshot({
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
  });
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
      await dependencies.runVersion(snapshot.cloudHypervisorBinary),
    );
    if (version !== CLOUD_HYPERVISOR_RELEASE_VERSION) {
      throw new Error(
      `Cloud Hypervisor is pinned to v${CLOUD_HYPERVISOR_RELEASE_VERSION}; found v${version}`,
      );
    }
    const virtiofsdVersion = parseVirtiofsdVersion(
      await dependencies.runVersion(snapshot.virtiofsdBinary),
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
