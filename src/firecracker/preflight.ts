import { createHash } from 'crypto';
import { createReadStream, constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  FIRECRACKER_RELEASE_VERSION,
  type FirecrackerOptions,
} from '../types/runtime-options';

export interface FirecrackerPreflightDependencies {
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
  assertHostPolicy(): Promise<1 | 2>;
  assertDockerInfrastructure(): Promise<void>;
}

export type FirecrackerHostToolPaths = Readonly<{
  ip: string;
  nft: string;
  sysctl: string;
  mke2fs: string;
  debugfs: string;
  e2fsck: string;
  rsync: string;
}>;
const FIRECRACKER_HOST_TOOLS: (keyof FirecrackerHostToolPaths)[] = [
  'ip', 'nft', 'sysctl', 'mke2fs', 'debugfs', 'e2fsck', 'rsync',
];

const defaultDependencies: FirecrackerPreflightDependencies = {
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
        'Firecracker jailer and network setup require root; invoke awf through sudo from a non-root account',
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
    } catch {
      try {
        await fs.access('/sys/fs/cgroup', constants.R_OK | constants.W_OK);
        return 1;
      } catch (error) {
        throw new Error(
          'Firecracker jailer requires a writable cgroup v1 hierarchy or cgroup v2 controllers: ' +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  },
  assertDockerInfrastructure: async () => {
    for (const args of [['info'], ['compose', 'version']] as const) {
      const result = await execa('docker', [...args], {
        reject: false,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `docker ${args.join(' ')} failed with code ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }
    }
  },
};

/** @internal Exposed only for focused host-probe tests. */
export const firecrackerPreflightTestHelpers = { defaultDependencies };

export interface FirecrackerPreflightResult {
  version: string;
  firecrackerBinary: string;
  jailerBinary: string;
  kernelPath: string;
  rootfsPath: string;
  supervisorPath: string;
  tools: FirecrackerHostToolPaths;
  cgroupVersion: 1 | 2;
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

export function parseFirecrackerVersion(output: string): string {
  const match = output.match(/\bv?(\d+\.\d+\.\d+)\b/);
  if (!match) {
    throw new Error(`Could not parse Firecracker version from: ${JSON.stringify(output)}`);
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
  dependencies: FirecrackerPreflightDependencies,
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
  dependencies: FirecrackerPreflightDependencies,
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
  dependencies: FirecrackerPreflightDependencies,
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
 * Fail-closed host and artifact validation for Firecracker v1.16.1.
 */
export async function runFirecrackerPreflight(
  config: FirecrackerOptions,
  overrides: Partial<FirecrackerPreflightDependencies> = {},
): Promise<FirecrackerPreflightResult> {
  const dependencies = {
    ...defaultDependencies,
    ...overrides,
    uid: overrides.uid ?? resolveTrustedOperatorUid(),
  };
  if (dependencies.platform !== 'linux') {
    throw new Error(`Firecracker requires Linux with KVM; found ${dependencies.platform}`);
  }
  if (dependencies.arch !== 'x64' && dependencies.arch !== 'arm64') {
    throw new Error(
      `Firecracker supports only x86_64 and aarch64; found Node architecture ${dependencies.arch}`,
    );
  }
  if (!config.kernelPath || !config.rootfsPath || !config.supervisorPath) {
    throw new Error(
      'Firecracker requires guest kernel, rootfs, and supervisor artifact paths',
    );
  }

  try {
    await dependencies.access('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch (error) {
    throw new Error(
      'Firecracker requires readable and writable /dev/kvm: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const cgroupVersion = await dependencies.assertHostPolicy();
  await dependencies.assertDockerInfrastructure();
  await assertTrustedRegularFile(
    'Firecracker binary',
    config.firecrackerBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  );

  const tools = {} as Record<keyof FirecrackerHostToolPaths, string>;
  for (const tool of FIRECRACKER_HOST_TOOLS) {
    try {
      tools[tool] = await dependencies.assertToolAvailable(tool);
    } catch (error) {
      throw new Error(
        `Firecracker requires host tool "${tool}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await assertTrustedRegularFile(
    'Firecracker jailer binary',
    config.jailerBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  );
  await assertTrustedRegularFile(
    'Firecracker guest kernel',
    config.kernelPath,
    constants.R_OK,
    dependencies,
  );
  await assertTrustedRegularFile(
    'Firecracker rootfs',
    config.rootfsPath,
    constants.R_OK,
    dependencies,
  );
  await assertTrustedRegularFile(
    'Firecracker guest supervisor',
    config.supervisorPath,
    constants.R_OK,
    dependencies,
  );

  const firecrackerVersion = parseFirecrackerVersion(
    await dependencies.runVersion(config.firecrackerBinary),
  );
  const jailerVersion = parseFirecrackerVersion(
    await dependencies.runVersion(config.jailerBinary),
  );
  if (firecrackerVersion !== jailerVersion) {
    throw new Error(
      `Firecracker and jailer versions must match; found ${firecrackerVersion} and ${jailerVersion}`,
    );
  }
  if (firecrackerVersion !== FIRECRACKER_RELEASE_VERSION) {
    throw new Error(
      `Firecracker is pinned to v${FIRECRACKER_RELEASE_VERSION}; found v${firecrackerVersion}`,
    );
  }

  await assertDigest(
    'Firecracker binary',
    config.firecrackerBinary,
    config.sha256?.firecracker,
    dependencies,
  );
  await assertDigest(
    'Firecracker jailer binary',
    config.jailerBinary,
    config.sha256?.jailer,
    dependencies,
  );
  await assertDigest(
    'Firecracker guest kernel',
    config.kernelPath,
    config.sha256?.kernel,
    dependencies,
  );
  await assertDigest(
    'Firecracker rootfs',
    config.rootfsPath,
    config.sha256?.rootfs,
    dependencies,
  );
  await assertDigest(
    'Firecracker guest supervisor',
    config.supervisorPath,
    config.sha256?.supervisor,
    dependencies,
  );

  return {
    version: firecrackerVersion,
    firecrackerBinary: config.firecrackerBinary,
    jailerBinary: config.jailerBinary,
    kernelPath: config.kernelPath,
    rootfsPath: config.rootfsPath,
    supervisorPath: config.supervisorPath,
    tools,
    cgroupVersion,
  };
}
