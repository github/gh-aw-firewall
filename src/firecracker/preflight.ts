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
}

const defaultDependencies: FirecrackerPreflightDependencies = {
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid?.() ?? -1,
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
};

export interface FirecrackerPreflightResult {
  version: string;
  firecrackerBinary: string;
  jailerBinary: string;
  kernelPath: string;
  rootfsPath: string;
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
  const dependencies = { ...defaultDependencies, ...overrides };
  if (dependencies.platform !== 'linux') {
    throw new Error(`Firecracker requires Linux with KVM; found ${dependencies.platform}`);
  }
  if (dependencies.arch !== 'x64' && dependencies.arch !== 'arm64') {
    throw new Error(
      `Firecracker supports only x86_64 and aarch64; found Node architecture ${dependencies.arch}`,
    );
  }
  if (!config.kernelPath || !config.rootfsPath) {
    throw new Error('Firecracker requires both guest kernel and rootfs artifact paths');
  }

  try {
    await dependencies.access('/dev/kvm', constants.R_OK | constants.W_OK);
  } catch (error) {
    throw new Error(
      'Firecracker requires readable and writable /dev/kvm: ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await assertTrustedRegularFile(
    'Firecracker binary',
    config.firecrackerBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  );
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

  return {
    version: firecrackerVersion,
    firecrackerBinary: config.firecrackerBinary,
    jailerBinary: config.jailerBinary,
    kernelPath: config.kernelPath,
    rootfsPath: config.rootfsPath,
  };
}
