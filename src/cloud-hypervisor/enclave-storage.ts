import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import { parseMountInfoLine } from './cleanup-identity';
import type { CloudHypervisorDirectoryExport } from './exports';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';

const TMPFS_MAGIC = 0x01021994n;
export const ENCLAVE_STORAGE_SOURCE = 'awf-enclave-invocation';

export interface EnclaveStorageDependencies {
  readonly realpath: (directory: string) => Promise<string>;
  readonly lstat: (directory: string) => Promise<{ uid: number; gid: number; mode: number }>;
  readonly readMountInfo: () => Promise<string>;
  readonly statfs: (directory: string) => Promise<{
    type: bigint; blocks: bigint; bsize: bigint;
  }>;
}

const defaultDependencies: EnclaveStorageDependencies = {
  realpath: fs.realpath,
  lstat: fs.lstat,
  readMountInfo: () => fs.readFile('/proc/self/mountinfo', 'utf8'),
  statfs: (directory) => fs.statfs(directory, { bigint: true }),
};

export async function mountBoundedEnclaveStorage(
  directory: string,
  sizeBytes: number,
  uid: number,
  gid: number,
  tools: { readonly mount: string },
): Promise<void> {
  if (!Object.values(CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES).some((profile) =>
    profile.writableStorageBytes === sizeBytes && profile.uid === uid && profile.gid === gid)) {
    throw new Error('Enclave storage requires a closed role profile');
  }
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory ||
    directory === '/' || await fs.realpath(directory) !== directory) {
    throw new Error('Enclave storage requires a canonical invocation directory');
  }
  const mountOptions = `size=${sizeBytes},mode=0700,uid=${uid},gid=${gid},nosuid,nodev,noexec`;
  const result = await execa(tools.mount, [
    '-t', 'tmpfs',
    '-o', mountOptions,
    ENCLAVE_STORAGE_SOURCE,
    directory,
  ], { reject: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to mount bounded enclave invocation storage: ${result.stderr.trim()}`);
  }
}

export async function unmountBoundedEnclaveStorage(
  directory: string,
  tools: { readonly umount: string },
): Promise<void> {
  // Never detach lazily: a busy mount must retain ownership and block admission.
  const result = await execa(tools.umount, [directory], {
    reject: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to unmount enclave invocation storage: ${result.stderr.trim()}`);
  }
}

/**
 * Verify the host mount, not free space or a guest tmpfs. All writable exports
 * must be direct children of one invocation-owned tmpfs with the closed role
 * capacity. Nested mounts (including bind mounts) cannot escape that budget.
 */
export async function assertBoundedEnclaveStorage(
  invocationDirectory: string,
  maximumBytes: number,
  writableDirectories: readonly string[] = [],
  dependencies: EnclaveStorageDependencies = defaultDependencies,
): Promise<void> {
  const profile = Object.values(CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES)
    .find((profile) => profile.writableStorageBytes === maximumBytes);
  if (
    !profile ||
    !path.isAbsolute(invocationDirectory) ||
    path.normalize(invocationDirectory) !== invocationDirectory ||
    invocationDirectory === '/' ||
    await dependencies.realpath(invocationDirectory) !== invocationDirectory
  ) {
    throw new Error('Invalid bounded enclave storage identity or role capacity');
  }
  for (const directory of writableDirectories) {
    if (
      path.dirname(directory) !== invocationDirectory ||
      path.normalize(directory) !== directory ||
      await dependencies.realpath(directory) !== directory
    ) {
      throw new Error('Writable enclave export escapes its invocation storage');
    }
  }
  const identity = await dependencies.lstat(invocationDirectory);
  if (identity.uid !== profile.uid || identity.gid !== profile.gid ||
    (identity.mode & 0o7777) !== 0o700) {
    throw new Error('Bounded enclave storage ownership does not match the closed role profile');
  }
  const lines = (await dependencies.readMountInfo()).trim().split('\n').filter(Boolean);
  const mounts = lines.map(parseMountInfoLine);
  const invocationMounts = mounts.filter(({ mountPoint }) => mountPoint === invocationDirectory);
  const mount = invocationMounts[0];
  if (
    invocationMounts.length !== 1 ||
    !mount ||
    mount.root !== '/' ||
    mount.filesystemType !== 'tmpfs' ||
    mount.source !== ENCLAVE_STORAGE_SOURCE ||
    mounts.some(({ mountPoint }) => mountPoint.startsWith(`${invocationDirectory}/`)) ||
    mounts.some((other) => other !== mount && other.device === mount.device)
  ) {
    throw new Error('Invocation-private bounded enclave tmpfs mount is missing or unverifiable');
  }
  const options = lines[mounts.indexOf(mount)].split(' ')[5].split(',');
  if (!['rw', 'nosuid', 'nodev', 'noexec'].every((option) => options.includes(option))) {
    throw new Error('Bounded enclave tmpfs mount options are unverifiable');
  }
  for (const directory of [invocationDirectory, ...writableDirectories]) {
    const filesystem = await dependencies.statfs(directory);
    if (
      filesystem.type !== TMPFS_MAGIC ||
      filesystem.blocks * filesystem.bsize !== BigInt(maximumBytes)
    ) {
      throw new Error('Bounded enclave tmpfs capacity does not match the closed role limit');
    }
  }
}

export async function assertBoundedEnclaveWritableExports(
  exports: readonly CloudHypervisorDirectoryExport[],
  maximumBytes: number,
): Promise<void> {
  const directories = exports.filter((entry) => entry.mode === 'rw').map((entry) => entry.source);
  if (directories.length === 0) {
    throw new Error('Cloud Hypervisor enclave requires bounded writable exports');
  }
  await assertBoundedEnclaveStorage(path.dirname(directories[0]), maximumBytes, directories);
}
