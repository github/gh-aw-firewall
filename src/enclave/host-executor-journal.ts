import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN, HOST_EXECUTOR_ENTRY_ID_PATTERN } from './host-executor-protocol';
import {
  resolveCleanupDependencies,
  type CleanupRegistryDependencies,
  type ResolvedCleanupDependencies,
} from '../cloud-hypervisor/cleanup-dependencies';
import {
  captureFileIdentity, captureProcessIdentity, processMatches, readMounts,
} from '../cloud-hypervisor/cleanup-process';
import {
  sameMountIdentity, validateProcessIdentity, isTrustedArtifactSnapshotDirectory,
  type FileIdentity, type MountIdentity, type ProcessIdentity,
} from '../cloud-hypervisor/cleanup-identity';
import {
  assertNoMountsUnder, claimRecord, removeExactDirectory,
} from '../cloud-hypervisor/cleanup-record-store';
import type { CloudHypervisorCleanupRegistry } from '../cloud-hypervisor/cleanup-registry';
import type { CloudHypervisorVmmIdentityToolPaths } from '../cloud-hypervisor/vmm-identity';

export const HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY =
  '/var/lib/awf-cloud-hypervisor/host-executor-journal';
export const HOST_EXECUTOR_STORAGE_ROOT = '/run/awf-cloud-hypervisor/enclave-storage';

export function hostExecutorStorageDirectory(vmRunId: string): string {
  if (!HOST_EXECUTOR_ID_PATTERN.test(vmRunId)) throw new Error('Invalid invocation storage ID');
  return path.join(HOST_EXECUTOR_STORAGE_ROOT, vmRunId);
}

export function hostExecutorJournalDirectory(run: HostExecutorRunState): string {
  return run.journalDir ?? HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY;
}

export function hostExecutorVmRunId(
  invocation: Pick<HostExecutorInvocationPlan, 'runId' | 'entryId' | 'invocationId'>,
): string {
  return createHash('sha256').update(JSON.stringify([
    'awf-host-enclave-v1', invocation.runId, invocation.entryId, invocation.invocationId,
  ])).digest('hex').slice(0, 32);
}

function prepareDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error('Host executor journal requires a normalized absolute directory');
  }
  // Reject symlinked ancestors before creating or writing anything.
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe journal ancestor');
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error('Untrusted journal ancestor owner');
      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
        throw new Error('Writable journal ancestor');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(path.dirname(current));
    }
  }
  const stat = fs.lstatSync(directory);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Host executor journal requires private owner-only storage');
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function persist(target: string, value: unknown, exclusive = false): void {
  const staging = `${target}.write-${randomBytes(16).toString('hex')}`;
  const fd = fs.openSync(staging,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    if (exclusive) {
      fs.linkSync(staging, target);
      fs.unlinkSync(staging);
    } else {
      fs.renameSync(staging, target);
    }
    syncDirectory(path.dirname(target));
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

/**
 * Permanent run tombstone and append-only lifecycle log. An existing run is
 * never resumed, even if its last write was torn or it closed successfully.
 * No payload, credential, capability or result is persisted.
 */
export class HostExecutorJournal {
  private readonly file: string;

  constructor(run: HostExecutorRunState) {
    if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor run identity');
    const directory = hostExecutorJournalDirectory(run);
    prepareDirectory(directory);
    this.file = path.join(directory, `${run.runId}.journal`);
    persist(this.file, { version: 1, runId: run.runId, state: 'open' }, true);
  }

  record(value: {
    invocationId?: string;
    entryId?: string;
    admissionId?: string;
    requestHash?: string;
    state: string;
    cancelGeneration?: number;
    outcome?: string;
    resultDigest?: string;
  }): void {
    const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('Unsafe host executor tombstone');
      }
      fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}

interface ResourceRecord {
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

async function trustedDirectory(directory: string, dependencies: ResolvedCleanupDependencies): Promise<FileIdentity> {
  if (await dependencies.realpath(directory) !== directory) throw new Error('Recovery path has symlink ancestors');
  const stat = await dependencies.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== dependencies.effectiveUid ||
    (stat.mode & 0o022) !== 0) throw new Error('Unsafe recovery directory');
  return captureFileIdentity(dependencies.lstat, directory);
}

async function assertIdentity(directory: string, identity: FileIdentity, dependencies: ResolvedCleanupDependencies): Promise<void> {
  const current = await trustedDirectory(directory, dependencies);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    throw new Error('Recovery directory identity changed');
  }
}

/**
 * Durable trusted control metadata, deliberately outside the charged data
 * superblock so a crash or full invocation cannot erase recovery identities.
 * No workload payload, credentials, results or artifact bytes are journaled.
 */
export class HostExecutorResourceJournal {
  private constructor(
    private readonly file: string,
    private readonly record: ResourceRecord,
    private readonly dependencies: ResolvedCleanupDependencies,
  ) {}

  static async create(
    run: HostExecutorRunState,
    plan: HostExecutorInvocationPlan,
    vmRunId: string,
    overrides: CleanupRegistryDependencies = {},
  ): Promise<HostExecutorResourceJournal> {
    const directory = hostExecutorJournalDirectory(run);
    prepareDirectory(directory);
    const dependencies = { ...resolveCleanupDependencies(overrides), rootDirectory: directory };
    const parent = path.dirname(plan.invocationHostDir);
    if (parent !== path.join(run.invocationsDir, plan.entryId) ||
      plan.invocationHostDir !== path.join(parent, plan.invocationId)) {
      throw new Error('Resource journal path is not invocation-owned');
    }
    const record: ResourceRecord = {
      version: 1, runId: run.runId, entryId: plan.entryId, invocationId: plan.invocationId,
      vmRunId, owner: await captureProcessIdentity(dependencies, dependencies.processId),
      bootId: (await dependencies.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      root: run.invocationsDir, directory: plan.invocationHostDir,
      ancestors: [
        { path: run.invocationsDir, identity: await trustedDirectory(run.invocationsDir, dependencies) },
        { path: parent, identity: await trustedDirectory(parent, dependencies) },
      ],
      mountPending: false, snapshotPending: false, state: 'pending',
    };
    const file = path.join(directory, `${run.runId}-${plan.invocationId}.resources.json`);
    validateResourceRecord(record, file);
    persist(file, record, true);
    return new HostExecutorResourceJournal(file, record, dependencies);
  }

  async captureDirectory(): Promise<void> {
    this.record.directoryIdentity = await trustedDirectory(this.record.directory, this.dependencies);
    this.record.mountPending = true;
    persist(this.file, this.record);
  }

  async captureMount(): Promise<void> {
    const mount = (await readMounts(this.dependencies.readFile)).find(
      (candidate) => candidate.mountPoint === this.record.directory,
    );
    if (!mount || mount.filesystemType !== 'tmpfs' || mount.source !== 'awf-enclave-invocation') {
      throw new Error('Invocation tmpfs identity is unavailable');
    }
    this.record.mount = mount;
    this.record.mountPending = false;
    persist(this.file, this.record);
  }

  async prepareStorage(): Promise<void> {
    this.record.storage = {
      directory: hostExecutorStorageDirectory(this.record.vmRunId),
      parentIdentity: await trustedDirectory(HOST_EXECUTOR_STORAGE_ROOT, this.dependencies),
      ancestors: await Promise.all(storageAncestors().map(async (directory) => ({
        path: directory, identity: await trustedDirectory(directory, this.dependencies),
      }))),
      mounts: [],
    };
    persist(this.file, this.record);
  }

  async captureStorageDirectory(): Promise<void> {
    const storage = this.record.storage!;
    storage.directoryIdentity = await trustedDirectory(storage.directory, this.dependencies);
    persist(this.file, this.record);
  }

  async prepareStorageMount(directory: string): Promise<void> {
    const storage = this.record.storage!;
    if (!allowedStorageMount(this.record, directory)) throw new Error('Unowned invocation mount');
    storage.pending = directory;
    persist(this.file, this.record);
  }

  async captureStorageMount(): Promise<void> {
    const storage = this.record.storage!;
    const mounts = (await readMounts(this.dependencies.readFile))
      .filter((mount) => mount.mountPoint === storage.pending);
    if (mounts.length !== 1 || mounts[0].filesystemType !== 'tmpfs' ||
      mounts[0].source !== 'awf-enclave-invocation') throw new Error('Storage mount identity unavailable');
    storage.mounts.push(mounts[0]);
    if (mounts[0].mountPoint === storage.directory) {
      storage.mountedIdentity = await trustedDirectory(storage.directory, this.dependencies);
    }
    delete storage.pending;
    persist(this.file, this.record);
  }

  async verifyStorage(): Promise<void> {
    await verifyStorageRecord(this.record, this.dependencies);
  }

  async releaseStorageMount(directory: string): Promise<void> {
    const storage = this.record.storage!;
    if (!allowedStorageMount(this.record, directory) ||
      !storage.mounts.some((mount) => mount.mountPoint === directory) ||
      (await readMounts(this.dependencies.readFile)).some((mount) => mount.mountPoint === directory)) {
      throw new Error('Invocation storage mount release is unverifiable');
    }
    storage.mounts = storage.mounts.filter((mount) => mount.mountPoint !== directory);
    persist(this.file, this.record);
  }

  async closeStorage(umount: string): Promise<void> {
    if (!this.record.storage) return;
    await closeStorageRecord(this.record, this.dependencies, umount);
  }

  async prepareSnapshot(): Promise<void> {
    this.record.snapshotPending = true;
    persist(this.file, this.record);
  }

  async captureSnapshot(directory: string): Promise<void> {
    // The snapshot creator chooses this path; a broker never does.
    if (!(this.record.storage
      ? path.dirname(directory) === path.join(this.record.storage.directory, 'artifacts')
      : isTrustedArtifactSnapshotDirectory(
      directory, path.join(path.dirname(this.record.root), 'runs', this.record.vmRunId),
    )) || !/^run-[A-Za-z0-9_-]+$/.test(path.basename(directory))) {
      throw new Error('Snapshot recovery path is outside trusted artifact storage');
    }
    this.record.snapshot = {
      path: directory, identity: await trustedDirectory(directory, this.dependencies),
      parentIdentity: await trustedDirectory(path.dirname(directory), this.dependencies),
    };
    this.record.snapshotPending = false;
    persist(this.file, this.record);
  }

  async verifyMount(): Promise<void> {
    const mounts = (await readMounts(this.dependencies.readFile)).filter(
      (mount) => mount.mountPoint === this.record.directory,
    );
    if (mounts.length !== 1 || !this.record.mount || !sameMountIdentity(mounts[0], this.record.mount)) {
      throw new Error('Invocation mount identity changed');
    }
  }

  async verifyDirectory(): Promise<void> {
    for (const ancestor of this.record.ancestors) {
      await assertIdentity(ancestor.path, ancestor.identity, this.dependencies);
    }
    if (!this.record.directoryIdentity) throw new Error('Invocation directory identity is uncommitted');
    await assertIdentity(this.record.directory, this.record.directoryIdentity, this.dependencies);
    await assertNoMountsUnder(this.dependencies, this.record.directory);
  }

  async verifySnapshot(): Promise<void> {
    const snapshot = this.record.snapshot;
    if (!snapshot) throw new Error('Snapshot identity is uncommitted');
    await assertIdentity(path.dirname(snapshot.path), snapshot.parentIdentity, this.dependencies);
    await assertIdentity(snapshot.path, snapshot.identity, this.dependencies);
    if (this.record.storage) await this.verifyStorage();
    else await assertNoMountsUnder(this.dependencies, snapshot.path);
  }

  async complete(): Promise<void> {
    if (this.record.snapshotPending && !this.record.snapshot) {
      throw new Error('Artifact staging identity is uncommitted');
    }
    for (const directory of [this.record.directory, this.record.snapshot?.path, this.record.storage?.directory]) {
      if (!directory) continue;
      try {
        await this.dependencies.lstat(directory);
        throw new Error('Invocation cleanup is incomplete');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.record.state = 'cleaned';
    persist(this.file, this.record);
  }
}

/**
 * VM cleanup must succeed first; only then may stale invocation storage be
 * reclaimed. Unknown identities/mount intents are retained for operator
 * recovery, never guessed from path names.
 */
export async function reapHostExecutorResources(
  directory: string,
  registry: CloudHypervisorCleanupRegistry,
  tools: { umount: string } & CloudHypervisorVmmIdentityToolPaths,
  overrides: CleanupRegistryDependencies = {},
): Promise<void> {
  prepareDirectory(directory);
  await registry.reapPending(tools.ip, tools.umount, tools);
  const vmDependencies = resolveCleanupDependencies(overrides);
  const dependencies = { ...vmDependencies, rootDirectory: directory };
  const bootId = (await dependencies.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  for (const name of await dependencies.readdir(directory)) {
    if (!name.endsWith('.resources.json')) continue;
    const identifiers = name.slice(0, -'.resources.json'.length).split('-');
    if (identifiers.length !== 2 || !identifiers.every((id) => HOST_EXECUTOR_ID_PATTERN.test(id))) {
      throw new Error('Invalid resource recovery filename');
    }
    const file = path.join(directory, name);
    const stat = await dependencies.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== dependencies.effectiveUid ||
      (stat.mode & 0o777) !== 0o600 || stat.size > 65_536) throw new Error('Unsafe resource recovery record');
    const record = JSON.parse(await dependencies.readFile(file, 'utf8')) as ResourceRecord;
    validateResourceRecord(record, file);
    if (record.state === 'cleaned') continue;
    if (record.bootId === bootId && await processMatches(dependencies, record.owner) &&
      !(await runWasClosed(directory, record.runId, dependencies))) continue;
    const release = await claimRecord(dependencies, file);
    if (!release) continue;
    try {
      if (record.snapshotPending && !record.snapshot) {
        throw new Error('Artifact staging identity is uncommitted');
      }
      // The registry checks its own recovery root, which may be customized.
      if (await registry.hasPendingRecord(record.vmRunId)) {
        throw new Error('VM cleanup must finish before invocation recovery');
      }
      for (const ancestor of record.ancestors) await assertIdentity(ancestor.path, ancestor.identity, dependencies);
      const mounts = await readMounts(dependencies.readFile);
      const current = mounts.find((mount) => mount.mountPoint === record.directory);
      if (record.storage && record.bootId !== bootId && mounts.some((mount) =>
        record.storage!.mounts.some((known) => mount.mountPoint === known.mountPoint))) {
        throw new Error('Invocation storage mount belongs to a different boot');
      }
      if (record.storage) await verifyStorageRecord(record, dependencies, true);
      if (current) {
        if (!record.mount || !sameMountIdentity(current, record.mount)) {
          throw new Error('Invocation mount identity is uncommitted or changed');
        }
        const result = await dependencies.run(tools.umount, [record.directory]);
        if (result.exitCode !== 0) throw new Error('Invocation unmount failed');
      }
      await assertNoMountsUnder(dependencies, record.directory);
      try {
        if (record.directoryIdentity) await assertIdentity(record.directory, record.directoryIdentity, dependencies);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await removeExactDirectory(record.directory, record.directoryIdentity, dependencies, true);
      if (record.storage) {
        await closeStorageRecord(record, dependencies, tools.umount);
        record.state = 'cleaned';
        persist(file, record);
        continue;
      }
      if (record.snapshot) {
        try {
          await assertIdentity(path.dirname(record.snapshot.path), record.snapshot.parentIdentity, dependencies);
          await assertIdentity(record.snapshot.path, record.snapshot.identity, dependencies);
          await assertNoMountsUnder(dependencies, record.snapshot.path);
          await removeExactDirectory(record.snapshot.path, record.snapshot.identity, dependencies, true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      record.state = 'cleaned';
      persist(file, record);
    } finally { await release(); }
  }
}

async function runWasClosed(
  directory: string,
  runId: string,
  dependencies: ResolvedCleanupDependencies,
): Promise<boolean> {
  let handle;
  try {
    handle = await dependencies.open(path.join(directory, `${runId}.journal`),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== dependencies.effectiveUid || (stat.mode & 0o777) !== 0o600) {
      throw new Error('Unsafe lifecycle recovery tombstone');
    }
    const bytes = Buffer.alloc(Math.min(stat.size, 256));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, stat.size - bytes.length);
    return bytes.subarray(0, bytesRead).toString('utf8').endsWith('{"state":"closed"}\n');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateResourceRecord(record: ResourceRecord, file: string): void {
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
        mount.root !== (mount.mountPoint === storage.directory ? '/' :
          mount.mountPoint === record.directory ? '/state' :
          path.dirname(mount.mountPoint) === storage.directory ? `/${path.basename(mount.mountPoint)}` :
            `/artifacts/${path.basename(mount.mountPoint)}`) ||
        !Number.isSafeInteger(mount.mountId) || mount.mountId <= 0) ||
      new Set(storage.mounts.map((mount) => mount.mountPoint)).size !== storage.mounts.length ||
      storage.mounts.some((mount) => mount.device !== storage.mounts[0].device)) {
      throw new Error('Invalid invocation storage record');
    }
  }
}

function storageAncestors(): string[] {
  return ['/', '/run', path.dirname(HOST_EXECUTOR_STORAGE_ROOT), HOST_EXECUTOR_STORAGE_ROOT];
}

function allowedStorageMount(record: ResourceRecord, directory: string): boolean {
  const root = hostExecutorStorageDirectory(record.vmRunId);
  return directory === root || directory === record.directory ||
    directory === path.join(root, 'runs') || directory === path.join(root, 'cloud-hypervisor-rootfs') ||
    directory === path.join(root, 'artifacts') ||
    (path.dirname(directory) === path.join(root, 'artifacts') &&
      /^run-[A-Za-z0-9_-]+$/.test(path.basename(directory)));
}

async function verifyStorageRecord(
  record: ResourceRecord, dependencies: ResolvedCleanupDependencies, allowRootMissing = false,
): Promise<void> {
  const storage = record.storage!;
  if (storage.pending || !storage.directoryIdentity) throw new Error('Storage identity is uncommitted');
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
      throw new Error('Invocation storage mount identity changed');
    }
  }
  if (current.some((mount) => (mount.mountPoint === storage.directory ||
    mount.mountPoint.startsWith(`${storage.directory}/`) ||
    mount.mountPoint.startsWith(`${record.directory}/`) ||
    storage.mounts.some((known) => known.device === mount.device)) &&
    !storage.mounts.some((known) => sameMountIdentity(known, mount)))) {
    throw new Error('Unrecorded invocation storage mount');
  }
}

async function closeStorageRecord(record: ResourceRecord, dependencies: ResolvedCleanupDependencies, umount: string): Promise<void> {
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
