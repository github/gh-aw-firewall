import * as fs from 'fs';
import * as path from 'path';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN } from './host-executor-protocol';
import {
  HOST_EXECUTOR_STORAGE_ROOT, hostExecutorJournalDirectory, hostExecutorStorageDirectory,
  prepareDirectory, persist,
} from './host-executor-journal-shared';
import {
  trustedDirectory, assertIdentity, validateResourceRecord, storageAncestors,
  allowedStorageMount, verifyStorageRecord, closeStorageRecord, type ResourceRecord,
} from './host-executor-storage-records';
import {
  resolveCleanupDependencies,
  type CleanupRegistryDependencies,
  type ResolvedCleanupDependencies,
} from '../cloud-hypervisor/cleanup-dependencies';
import { captureProcessIdentity, processMatches, readMounts } from '../cloud-hypervisor/cleanup-process';
import { sameMountIdentity, isTrustedArtifactSnapshotDirectory } from '../cloud-hypervisor/cleanup-identity';
import { assertNoMountsUnder, claimRecord, removeExactDirectory } from '../cloud-hypervisor/cleanup-record-store';
import type { CloudHypervisorCleanupRegistry } from '../cloud-hypervisor/cleanup-registry';
import type { CloudHypervisorVmmIdentityToolPaths } from '../cloud-hypervisor/vmm-identity';
import { HostPreflightReporter, markHostPreflightError } from '../cloud-hypervisor/host-preflight-progress';

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

  async publicDebugRetention(pending: boolean): Promise<void> {
    this.record.publicDebugRetentionPending = pending;
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

  async captureStorageMount(
    report = new HostPreflightReporter('storage-mount-capture'),
    observe?: (text: string) => void,
  ): Promise<void> {
    const storage = this.record.storage!;
    await report.check('canonical-path', async () => {
      if (!storage.pending || await this.dependencies.realpath(storage.pending) !== storage.pending) {
        throw markHostPreflightError(new Error('Storage mount path changed'), 'storage-path-changed');
      }
    });
    const mounts = (await readMounts(this.dependencies.readFile, report, observe))
      .filter((mount) => mount.mountPoint === storage.pending);
    report.checkSync('match-count', () => {
      if (mounts.length !== 1) {
        throw markHostPreflightError(new Error('Storage mount identity unavailable'),
          mounts.length === 0 ? 'storage-mount-missing' : 'storage-mount-multiple');
      }
    });
    report.checkSync('filesystem', () => {
      if (mounts[0].filesystemType !== 'tmpfs') {
        throw markHostPreflightError(new Error('Storage mount filesystem changed'), 'storage-mount-filesystem');
      }
    });
    report.checkSync('source', () => {
      if (mounts[0].source !== 'awf-enclave-invocation') {
        throw markHostPreflightError(new Error('Storage mount source changed'), 'storage-mount-source');
      }
    });
    storage.mounts.push(mounts[0]);
    if (mounts[0].mountPoint === storage.directory) {
      storage.mountedIdentity = await trustedDirectory(storage.directory, this.dependencies);
    }
    delete storage.pending;
    persist(this.file, this.record, false, report);
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
    if (record.publicDebugRetentionPending) {
      throw new Error('Public enclave diagnostic retention requires trusted recovery; invocation sources are preserved');
    }
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
