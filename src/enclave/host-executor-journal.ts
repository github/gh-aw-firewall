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

export function hostExecutorJournalDirectory(run: HostExecutorRunState): string {
  return run.journalDir ?? '/var/lib/awf-cloud-hypervisor/host-executor-journal';
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

/** Durable write-ahead intent for invocation tmpfs and staged artifacts. */
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

  async prepareSnapshot(): Promise<void> {
    this.record.snapshotPending = true;
    persist(this.file, this.record);
  }

  async captureSnapshot(directory: string): Promise<void> {
    // The snapshot creator chooses this path; a broker never does.
    if (!isTrustedArtifactSnapshotDirectory(
      directory, path.join(path.dirname(this.record.root), 'runs', this.record.vmRunId),
    ) || !/^run-[A-Za-z0-9_-]+$/.test(path.basename(directory))) {
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
    const current = (await readMounts(this.dependencies.readFile)).find(
      (mount) => mount.mountPoint === this.record.directory,
    );
    if (!current || !this.record.mount || !sameMountIdentity(current, this.record.mount)) {
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
    await assertNoMountsUnder(this.dependencies, snapshot.path);
  }

  async complete(): Promise<void> {
    if (this.record.snapshotPending && !this.record.snapshot) {
      throw new Error('Artifact staging identity is uncommitted');
    }
    for (const directory of [this.record.directory, this.record.snapshot?.path]) {
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
  tools: { ip: string; umount: string } & Partial<CloudHypervisorVmmIdentityToolPaths>,
  overrides: CleanupRegistryDependencies = {},
): Promise<void> {
  prepareDirectory(directory);
  if (tools.getfacl && tools.groupdel && tools.getent && tools.id &&
    tools.setfacl && tools.useradd && tools.userdel) {
    await registry.reapPending(tools.ip, tools.umount, {
      ip: tools.ip, getfacl: tools.getfacl, groupdel: tools.groupdel,
      getent: tools.getent, id: tools.id, setfacl: tools.setfacl,
      useradd: tools.useradd, userdel: tools.userdel,
    });
  } else {
    await registry.reapPending(tools.ip, tools.umount);
  }
  const vmDependencies = resolveCleanupDependencies(overrides);
  const dependencies = { ...vmDependencies, rootDirectory: directory };
  const bootId = (await dependencies.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  for (const name of await dependencies.readdir(directory)) {
    if (!name.endsWith('.resources.json')) continue;
    const identifiers = name.slice(0, -'.resources.json'.length).split('-');
    if (identifiers.length !== 2 || !identifiers.every((id) => HOST_EXECUTOR_ID_PATTERN.test(id))) continue;
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
      // A live or unresolved VM record still owns these exports.
      try {
        await dependencies.lstat(path.join(vmDependencies.rootDirectory, `${record.vmRunId}.json`));
        throw new Error('VM cleanup must finish before invocation recovery');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const ancestor of record.ancestors) await assertIdentity(ancestor.path, ancestor.identity, dependencies);
      const mounts = await readMounts(dependencies.readFile);
      const current = mounts.find((mount) => mount.mountPoint === record.directory);
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
  for (const identity of [
    ...record.ancestors.map((ancestor) => ancestor.identity), record.directoryIdentity,
    record.snapshot?.identity, record.snapshot?.parentIdentity,
  ]) {
    if (identity !== undefined && (!/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode))) {
      throw new Error('Invalid recovery file identity');
    }
  }
  if (record.snapshot && (!path.isAbsolute(record.snapshot.path) ||
    path.normalize(record.snapshot.path) !== record.snapshot.path ||
    !isTrustedArtifactSnapshotDirectory(
      record.snapshot.path, path.join(path.dirname(record.root), 'runs', record.vmRunId),
    ) || !/^run-[A-Za-z0-9_-]+$/.test(path.basename(record.snapshot.path)))) {
    throw new Error('Invalid snapshot path');
  }
  if (record.mount && (record.mount.mountPoint !== record.directory ||
    record.mount.filesystemType !== 'tmpfs' || record.mount.source !== 'awf-enclave-invocation')) {
    throw new Error('Invalid invocation mount record');
  }
}
