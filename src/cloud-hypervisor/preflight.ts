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
import { CloudHypervisorUnsupportedHostError } from './errors';
import { logger } from '../logger';
import { CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT } from './manager-types';

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
    size: number;
    uid: number;
  }>;
  runVersion(binaryPath: string): Promise<string>;
  sha256(filePath: string): Promise<string>;
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

const CLOUD_HYPERVISOR_HOST_TOOLS: (keyof CloudHypervisorHostToolPaths)[] = [
  'getent', 'getfacl', 'groupdel', 'id', 'ip', 'nft', 'sysctl', 'flock', 'mke2fs', 'debugfs', 'e2fsck',
  'rsync', 'mount', 'umount', 'setfacl', 'setpriv', 'useradd', 'userdel',
];
const CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_PARENT = path.dirname(
  CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT,
);
const GETFACL_DIAGNOSTIC_PATHS = ['/usr/bin/getfacl', '/bin/getfacl'] as const;

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

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

function mountInfoUnescape(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function pathIsUnderMount(target: string, mountPoint: string): boolean {
  const normalizedMountPoint = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
  return target === mountPoint || target.startsWith(normalizedMountPoint);
}

interface CloudHypervisorMountDescription {
  mountPoint: string;
  filesystemType: string;
  source: string;
  /** Per-mount options, e.g. `rw,nosuid,nodev,noexec,relatime`. */
  options: string;
  /** Superblock options, which can independently carry `noexec`. */
  superblockOptions: string;
}

/**
 * Resolves the most specific `/proc/self/mountinfo` entry containing
 * `filePath`, so execution failures can be attributed to the mount the
 * trusted artifacts were staged on.
 */
function findMountForPath(
  mountInfo: string,
  filePath: string,
): CloudHypervisorMountDescription | undefined {
  let best: CloudHypervisorMountDescription | undefined;
  for (const line of mountInfo.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 6 || right.length < 3) continue;
    const mountPoint = mountInfoUnescape(left[4]);
    if (!pathIsUnderMount(filePath, mountPoint)) continue;
    if (!best || mountPoint.length > best.mountPoint.length) {
      best = {
        mountPoint,
        filesystemType: right[0],
        source: mountInfoUnescape(right[1]),
        options: left[5],
        superblockOptions: right[2],
      };
    }
  }
  return best;
}

function mountRejectsExecution(mount: CloudHypervisorMountDescription): boolean {
  return [mount.options, mount.superblockOptions].some((options) =>
    options.split(',').includes('noexec'));
}

/**
 * Fails closed before any artifact is staged when the trusted-artifact root
 * sits on a `noexec` mount. Without this the copy succeeds and the failure
 * only surfaces later as an opaque `EACCES` from the `--version` probe,
 * which aborts the whole engine run. See gh-aw-firewall#8827.
 *
 * Best effort: when `/proc/self/mountinfo` is unreadable or has no matching
 * entry the staging continues, and the digest-verified `--version` probe
 * remains the authoritative execution check.
 */
async function assertExecCapableArtifactRoot(directory: string): Promise<void> {
  let mount: CloudHypervisorMountDescription | undefined;
  try {
    mount = findMountForPath(await fs.readFile('/proc/self/mountinfo', 'utf8'), directory);
  } catch {
    return;
  }
  if (!mount || !mountRejectsExecution(mount)) return;
  throw new Error(
    `Cloud Hypervisor trusted artifact root "${directory}" is on a mount that rejects ` +
    `execution (mount: ${mount.mountPoint} type=${mount.filesystemType} ` +
    `source=${mount.source} options=${mount.options} superblock=${mount.superblockOptions}); ` +
    'remount it without "noexec" so the staged cloud-hypervisor binary can be executed',
  );
}

async function describeMountForPath(filePath: string): Promise<string> {
  try {
    const best = findMountForPath(
      await fs.readFile('/proc/self/mountinfo', 'utf8'),
      filePath,
    );
    if (!best) return 'mount: unavailable (no /proc/self/mountinfo match)';
    return `mount: ${best.mountPoint} type=${best.filesystemType} source=${best.source} options=${best.options}`;
  } catch (error) {
    return `mount: unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function describeAcl(filePath: string): Promise<string> {
  try {
    const getfaclPath = await resolveDiagnosticGetfaclPath();
    const result = await execa(getfaclPath, ['-cp', '--absolute-names', '--', filePath], {
      reject: false,
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      return `acl=unavailable(getfacl exit ${result.exitCode}${output ? `: ${output}` : ''})`;
    }
    return `acl=${output.replace(/\s+/g, ' ')}`;
  } catch (error) {
    return `acl=unavailable(${error instanceof Error ? error.message : String(error)})`;
  }
}

async function resolveDiagnosticGetfaclPath(): Promise<string> {
  for (const candidate of GETFACL_DIAGNOSTIC_PATHS) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known system location without consulting PATH.
    }
  }
  throw new Error(`getfacl not found at ${GETFACL_DIAGNOSTIC_PATHS.join(' or ')}`);
}

function pathComponents(filePath: string): string[] {
  const { root } = path.parse(filePath);
  const components = [root];
  let current = root;
  for (const segment of filePath.slice(root.length).split('/').filter(Boolean)) {
    current = path.join(current, segment);
    components.push(current);
  }
  return components;
}

async function describePathComponent(filePath: string): Promise<string> {
  let statDescription: string;
  try {
    const stat = await fs.lstat(filePath);
    const type = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory()
        ? 'dir'
        : stat.isFile()
          ? 'file'
          : 'other';
    statDescription =
      `stat=${type},mode=${formatMode(stat.mode)},uid=${stat.uid},gid=${stat.gid},size=${stat.size}`;
  } catch (error) {
    statDescription = `stat=unavailable(${error instanceof Error ? error.message : String(error)})`;
  }
  return `${filePath}: ${statDescription}; ${await describeAcl(filePath)}`;
}

async function buildExecutionFailureDiagnostics(binaryPath: string): Promise<string> {
  const uid = process.getuid?.();
  const euid = process.geteuid?.();
  const gid = process.getgid?.();
  const egid = process.getegid?.();
  const groups = process.getgroups?.();
  const identity =
    `uid=${uid ?? 'unknown'},euid=${euid ?? 'unknown'},` +
    `gid=${gid ?? 'unknown'},egid=${egid ?? 'unknown'},` +
    `groups=${groups ? groups.join(',') : 'unknown'}`;
  const lines = [
    'Cloud Hypervisor execution diagnostics:',
    `identity: ${identity}`,
    await describeMountForPath(binaryPath),
    'path components:',
  ];
  for (const component of pathComponents(binaryPath)) {
    lines.push(`  - ${await describePathComponent(component)}`);
  }
  return `\n${lines.join('\n')}`;
}

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

async function createArtifactSnapshot(
  sources: CloudHypervisorArtifactSnapshotSources,
  copySparseFile: (source: string, destination: string) => Promise<void>,
): Promise<CloudHypervisorArtifactSnapshot> {
  await fs.mkdir(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_PARENT, {
    recursive: true,
    mode: 0o711,
  });
  await fs.chmod(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_PARENT, 0o711);
  await fs.mkdir(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, {
    recursive: true,
    mode: 0o711,
  });
  await fs.chmod(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 0o711);
  await assertExecCapableArtifactRoot(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT);
  const directory = await fs.mkdtemp(
    path.join(CLOUD_HYPERVISOR_ARTIFACT_SNAPSHOT_ROOT, 'run-'),
  );
  const copy = async (
    source: string,
    name: string,
    mode: number,
  ): Promise<string> => {
    const destination = path.join(directory, name);
    if (name === 'rootfs.ext4') {
      await copySparseFile(source, destination);
    } else {
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    }
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

export async function copySparseFileWithRsync(
  rsyncBinaryPath: string,
  source: string,
  destination: string,
): Promise<void> {
  const result = await execa(rsyncBinaryPath, ['--sparse', '--', source, destination], {
    reject: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `sparse artifact copy failed with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
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

  const stat = await dependencies.lstat(filePath);
  if (stat.size <= 0) {
    throw new Error(
      `${label} trusted artifact is empty or incomplete before execution: ${filePath}`,
    );
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
