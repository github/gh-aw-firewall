import { createHash } from 'crypto';
import { createReadStream, constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  CLOUD_HYPERVISOR_RELEASE_VERSION,
  type CloudHypervisorOptions,
} from '../types/runtime-options';

/**
 * Fail-closed host and artifact validation for the Cloud Hypervisor v53.0
 * runtime. This module intentionally mirrors
 * `src/firecracker/preflight.ts`'s trust-check patterns (absolute paths,
 * root/operator-owned non-writable regular files, trusted ancestor
 * directories, digest pinning, PATH-resolved but ownership-verified host
 * tools) so both VMM backends share the same fail-closed posture.
 *
 * Cloud Hypervisor has no jailer-equivalent process, so there is no paired
 * binary version cross-check the way Firecracker cross-checks jailer.
 * Instead `src/cloud-hypervisor/launcher.ts` builds an equivalent
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
  assertToolAvailable(tool: string): Promise<string>;
  assertHostPolicy(): Promise<2>;
  assertDockerInfrastructure(dockerBinaryPath: string): Promise<void>;
  /** Resolves the group ID that owns `/dev/kvm`, so the launcher can retain
   * exactly that supplementary group instead of the full operator group set. */
  resolveKvmGid(): Promise<number>;
}

export type CloudHypervisorHostToolPaths = Readonly<{
  ip: string;
  nft: string;
  sysctl: string;
  mke2fs: string;
  debugfs: string;
  e2fsck: string;
  rsync: string;
  /**
   * util-linux `setpriv`, used by the launcher to drop to the non-root
   * operator uid/gid and clear capabilities/groups after joining the
   * per-run network namespace (there is no jailer-equivalent process to do
   * this for Cloud Hypervisor). See `src/cloud-hypervisor/launcher.ts`.
   */
  setpriv: string;
}>;
const CLOUD_HYPERVISOR_HOST_TOOLS: (keyof CloudHypervisorHostToolPaths)[] = [
  'ip', 'nft', 'sysctl', 'mke2fs', 'debugfs', 'e2fsck', 'rsync', 'setpriv',
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
  kernelPath: string;
  rootfsPath: string;
  supervisorPath: string;
  tools: CloudHypervisorHostToolPaths;
  cgroupVersion: 2;
  /** Group ID that owns `/dev/kvm`, retained as the launcher's sole supplementary group. */
  kvmGid: number;
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
  const stat = await dependencies.lstat(filePath);
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

/**
 * Fail-closed host and artifact validation for Cloud Hypervisor v53.0.
 *
 * This performs the same categories of checks as
 * `runFirecrackerPreflight` — Linux/KVM host requirements, trusted
 * artifact ownership/permissions, pinned version, and pinned digests —
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
  await assertDigest(
    'Cloud Hypervisor binary',
    config.cloudHypervisorBinary,
    config.sha256?.cloudHypervisor,
    dependencies,
  );

  const version = parseCloudHypervisorVersion(
    await dependencies.runVersion(config.cloudHypervisorBinary),
  );
  if (version !== CLOUD_HYPERVISOR_RELEASE_VERSION) {
    throw new Error(
      `Cloud Hypervisor is pinned to v${CLOUD_HYPERVISOR_RELEASE_VERSION}; found v${version}`,
    );
  }

  await assertDigest(
    'Cloud Hypervisor guest kernel',
    config.kernelPath,
    config.sha256?.kernel,
    dependencies,
  );
  await assertDigest(
    'Cloud Hypervisor rootfs',
    config.rootfsPath,
    config.sha256?.rootfs,
    dependencies,
  );
  await assertDigest(
    'Cloud Hypervisor guest supervisor',
    config.supervisorPath,
    config.sha256?.supervisor,
    dependencies,
  );

  return {
    version,
    cloudHypervisorBinary: config.cloudHypervisorBinary,
    kernelPath: config.kernelPath,
    rootfsPath: config.rootfsPath,
    supervisorPath: config.supervisorPath,
    tools,
    cgroupVersion,
    kvmGid,
  };
}
