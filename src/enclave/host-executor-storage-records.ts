import * as path from 'path';
import {
  HOST_EXECUTOR_ID_PATTERN, HOST_EXECUTOR_ENTRY_ID_PATTERN,
} from './host-executor-protocol';
import {
  HOST_EXECUTOR_STORAGE_ROOT, hostExecutorStorageDirectory, hostExecutorVmRunId,
} from './host-executor-journal';
import type { ResolvedCleanupDependencies } from '../cloud-hypervisor/cleanup-dependencies';
import { captureFileIdentity, readMounts } from '../cloud-hypervisor/cleanup-process';
import {
  sameMountIdentity, validateProcessIdentity, isTrustedArtifactSnapshotDirectory,
  type FileIdentity, type MountIdentity, type ProcessIdentity,
} from '../cloud-hypervisor/cleanup-identity';
import { assertNoMountsUnder, removeExactDirectory } from '../cloud-hypervisor/cleanup-record-store';
import { markHostPreflightError } from '../cloud-hypervisor/host-preflight-progress';

export interface ResourceRecord {
  version: 1;
  runId: string;
  entryId: string;
  invocationId: string;
  vmRunId: string;
  owner: ProcessIdentity;
  bootId: string;
  root: string;
  directory: string;
  ancestors: Array<{ path: string; identity: FileIdentity }>;
  directoryIdentity?: FileIdentity;
  mountPending: boolean;
  mount?: MountIdentity;
  snapshot?: { path: string; identity: FileIdentity; parentIdentity: FileIdentity };
  snapshotPending: boolean;
  state: 'pending' | 'cleaned';
  storage?: {
    directory: string;
    parentIdentity: FileIdentity;
    ancestors: Array<{ path: string; identity: FileIdentity }>;
    directoryIdentity?: FileIdentity;
    mountedIdentity?: FileIdentity;
    pending?: string;
    mounts: MountIdentity[];
  };
}

export async function trustedDirectory(directory: string, dependencies: ResolvedCleanupDependencies): Promise<FileIdentity> {
  if (await dependencies.realpath(directory) !== directory) throw new Error('Recovery path has symlink ancestors');
  const stat = await dependencies.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== dependencies.effectiveUid ||
    (stat.mode & 0o022) !== 0) throw new Error('Unsafe recovery directory');
  return captureFileIdentity(dependencies.lstat, directory);
}

export async function assertIdentity(directory: string, identity: FileIdentity, dependencies: ResolvedCleanupDependencies): Promise<void> {
  const current = await trustedDirectory(directory, dependencies);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    throw new Error('Recovery directory identity changed');
  }
}

export function validateResourceRecord(record: ResourceRecord, file: string): void {
  if (record?.version !== 1 || typeof record.runId !== 'string' ||
    typeof record.invocationId !== 'string' || typeof record.vmRunId !== 'string' ||
    typeof record.entryId !== 'string' || !HOST_EXECUTOR_ID_PATTERN.test(record.runId) ||
    !HOST_EXECUTOR_ID_PATTERN.test(record.invocationId) || !HOST_EXECUTOR_ID_PATTERN.test(record.vmRunId) ||
    record.vmRunId !== hostExecutorVmRunId(record) ||
    !HOST_EXECUTOR_ENTRY_ID_PATTERN.test(record.entryId) ||
    path.basename(file) !== `${record.runId}-${record.invocationId}.resources.json` ||
    typeof record.root !== 'string' || !path.isAbsolute(record.root) || path.normalize(record.root) !== record.root ||
    record.directory !== path.join(record.root, record.entryId, record.invocationId) ||
    !['pending', 'cleaned'].includes(record.state) || typeof record.bootId !== 'string' ||
    typeof record.mountPending !== 'boolean' || typeof record.snapshotPending !== 'boolean' ||
    !Array.isArray(record.ancestors) || record.ancestors.length !== 2 ||
    record.ancestors[0]?.path !== record.root ||
    record.ancestors[1]?.path !== path.dirname(record.directory)) {
    throw new Error('Invalid resource recovery record');
  }
  validateProcessIdentity(record.owner, 'host executor owner');
  if (record.snapshot !== undefined && (!record.snapshot || typeof record.snapshot.path !== 'string')) {
    throw new Error('Invalid snapshot path');
  }
  for (const identity of [
    ...record.ancestors.map((ancestor) => ancestor.identity),
    ...(record.directoryIdentity === undefined ? [] : [record.directoryIdentity]),
    ...(record.snapshot === undefined ? [] : [record.snapshot.identity, record.snapshot.parentIdentity]),
    ...(record.storage === undefined ? [] : [
      record.storage.parentIdentity,
      ...(record.storage.directoryIdentity ? [record.storage.directoryIdentity] : []),
      ...(record.storage.mountedIdentity ? [record.storage.mountedIdentity] : []),
      ...record.storage.ancestors.map((ancestor) => ancestor.identity),
    ]),
  ]) {
    if (!identity || typeof identity.device !== 'string' || typeof identity.inode !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(identity.device) ||
      !/^[1-9][0-9]{0,19}$/.test(identity.inode) ||
      BigInt(identity.device) > 0xffffffffffffffffn || BigInt(identity.inode) > 0xffffffffffffffffn) {
      throw new Error('Invalid recovery file identity');
    }
  }
  if (record.snapshot && (!path.isAbsolute(record.snapshot.path) ||
    path.normalize(record.snapshot.path) !== record.snapshot.path ||
    !(record.storage
      ? path.dirname(record.snapshot.path) === path.join(hostExecutorStorageDirectory(record.vmRunId), 'artifacts')
      : isTrustedArtifactSnapshotDirectory(
      record.snapshot.path, path.join(path.dirname(record.root), 'runs', record.vmRunId),
    )) || !/^run-[A-Za-z0-9_-]+$/.test(path.basename(record.snapshot.path)))) {
    throw new Error('Invalid snapshot path');
  }
  if (record.mount !== undefined && (!record.mount ||
    !Number.isSafeInteger(record.mount.mountId) || record.mount.mountId <= 0 ||
    typeof record.mount.device !== 'string' || !/^\d+:\d+$/.test(record.mount.device) ||
    !record.mount.device.split(':').every((value) => Number.isSafeInteger(Number(value))) ||
    record.mount.root !== (record.storage ? '/state' : '/') || record.mount.mountPoint !== record.directory ||
    record.mount.filesystemType !== 'tmpfs' || record.mount.source !== 'awf-enclave-invocation')) {
    throw new Error('Invalid invocation mount record');
  }
  if (record.storage) {
    const storage = record.storage;
    if (storage.directory !== hostExecutorStorageDirectory(record.vmRunId) ||
      !storage.parentIdentity || !Array.isArray(storage.mounts) ||
      !Array.isArray(storage.ancestors) || storage.ancestors.length !== storageAncestors().length ||
      storage.ancestors.some((ancestor, index) => ancestor.path !== storageAncestors()[index]) ||
      (storage.pending !== undefined && !allowedStorageMount(record, storage.pending)) ||
      storage.mounts.some((mount) => !allowedStorageMount(record, mount.mountPoint) ||
        mount.filesystemType !== 'tmpfs' || mount.source !== 'awf-enclave-invocation' ||
        !/^\d+:\d+$/.test(mount.device) ||
        !mount.device.split(':').every((value) => Number.isSafeInteger(Number(value))) ||
        !Number.isSafeInteger(mount.mountId) || mount.mountId <= 0) ||
      new Set(storage.mounts.map((mount) => mount.mountPoint)).size !== storage.mounts.length ||
      !validStorageBackingLayout(record)) {
      throw new Error('Invalid invocation storage record');
    }
  }
}

function validStorageBackingLayout(record: ResourceRecord): boolean {
  const storage = record.storage!;
  if (!storage.mounts.length) return true;
  const allocation = storage.mounts[0];
  if (allocation.mountPoint !== storage.directory || allocation.root !== '/') return false;
  const artifacts = storage.mounts.find((mount) => mount.mountPoint === path.join(storage.directory, 'artifacts'));
  const independent = storage.mounts.filter((mount) =>
    path.dirname(mount.mountPoint) === storage.directory && mount.root === '/');
  if (new Set([allocation.device, ...independent.map((mount) => mount.device)]).size !== independent.length + 1) {
    return false;
  }
  return storage.mounts.every((mount) => {
    if (mount === allocation || independent.includes(mount)) return true;
    const snapshot = path.dirname(mount.mountPoint) === path.join(storage.directory, 'artifacts');
    const backing = snapshot ? artifacts ?? allocation : allocation;
    const expectedRoot = mount.mountPoint === record.directory ? '/state' :
      snapshot ? path.posix.join(artifacts?.root ?? '/artifacts', path.basename(mount.mountPoint)) :
        `/${path.basename(mount.mountPoint)}`;
    return mount.device === backing.device && mount.root === expectedRoot;
  });
}

export function storageAncestors(): string[] {
  return ['/', '/run', path.dirname(HOST_EXECUTOR_STORAGE_ROOT), HOST_EXECUTOR_STORAGE_ROOT];
}

export function allowedStorageMount(record: ResourceRecord, directory: string): boolean {
  const root = hostExecutorStorageDirectory(record.vmRunId);
  return directory === root || directory === record.directory ||
    directory === path.join(root, 'runs') || directory === path.join(root, 'cloud-hypervisor-rootfs') ||
    directory === path.join(root, 'artifacts') ||
    (path.dirname(directory) === path.join(root, 'artifacts') &&
      /^run-[A-Za-z0-9_-]+$/.test(path.basename(directory)));
}

export async function verifyStorageRecord(
  record: ResourceRecord, dependencies: ResolvedCleanupDependencies, allowRootMissing = false,
): Promise<void> {
  const storage = record.storage!;
  if (storage.pending || !storage.directoryIdentity) {
    throw markHostPreflightError(new Error('Storage identity is uncommitted'), 'storage-identity-uncommitted');
  }
  await assertIdentity(HOST_EXECUTOR_STORAGE_ROOT, storage.parentIdentity, dependencies);
  for (const ancestor of storage.ancestors) {
    await assertIdentity(ancestor.path, ancestor.identity, dependencies);
  }
  const current = await readMounts(dependencies.readFile);
  if (current.some((mount) => mount.mountPoint === storage.directory)) {
    if (!storage.mountedIdentity) throw new Error('Mounted storage inode identity is uncommitted');
    await assertIdentity(storage.directory, storage.mountedIdentity, dependencies);
  }
  if (!current.some((mount) => mount.mountPoint === storage.directory)) {
    if (!allowRootMissing) throw new Error('Invocation storage enforcement is missing');
    try {
      await assertIdentity(storage.directory, storage.directoryIdentity, dependencies);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const mount of storage.mounts) {
    const candidates = current.filter((candidate) => candidate.mountPoint === mount.mountPoint);
    if ((!allowRootMissing && candidates.length !== 1) || candidates.length > 1 ||
      (candidates.length === 1 && !sameMountIdentity(candidates[0], mount))) {
      throw markHostPreflightError(new Error('Invocation storage mount identity changed'), 'storage-mount-identity-changed');
    }
  }
  if (current.some((mount) => (mount.mountPoint === storage.directory ||
    mount.mountPoint.startsWith(`${storage.directory}/`) ||
    mount.mountPoint.startsWith(`${record.directory}/`) ||
    storage.mounts.some((known) => known.device === mount.device)) &&
    !storage.mounts.some((known) => sameMountIdentity(known, mount)))) {
    throw markHostPreflightError(new Error('Unrecorded invocation storage mount'), 'storage-mount-unrecorded');
  }
}

export async function closeStorageRecord(record: ResourceRecord, dependencies: ResolvedCleanupDependencies, umount: string): Promise<void> {
  await verifyStorageRecord(record, dependencies, true);
  const storage = record.storage!;
  for (const mount of [...storage.mounts].reverse()) {
    const current = (await readMounts(dependencies.readFile)).find((candidate) => candidate.mountPoint === mount.mountPoint);
    if (!current) continue;
    if (!sameMountIdentity(current, mount)) throw new Error('Invocation storage mount replaced');
    const result = await dependencies.run(umount, [mount.mountPoint]);
    if (result.exitCode !== 0) throw new Error('Invocation storage unmount failed');
  }
  try {
    await assertIdentity(storage.directory, storage.directoryIdentity!, dependencies);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  await assertNoMountsUnder(dependencies, storage.directory);
  await removeExactDirectory(storage.directory, storage.directoryIdentity, dependencies, true);
}
