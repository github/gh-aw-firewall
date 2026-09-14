import * as path from 'path';
import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorRunPaths } from './manager-types';
import type { CloudHypervisorVmmIdentityToolPaths } from './vmm-identity';
import { createCleanupHandle } from './cleanup-handle';
import {
  assertSafeRecordPaths,
  CLEANUP_RECORD_VERSION,
  type CleanupRecord,
  type FileIdentity,
} from './cleanup-identity';
import {
  captureFileIdentity,
  captureInterfaceIdentity,
  captureProcessIdentity,
  processMatches,
  readMounts,
  stopProcess,
} from './cleanup-process';
import {
  formatError,
  pathExists,
  resolveCleanupDependencies,
  type CleanupRegistryDependencies,
  type ResolvedCleanupDependencies,
} from './cleanup-dependencies';
import { deleteNetwork, validateRecordResources } from './cleanup-network';
import { deleteVmmIdentity } from './cleanup-vmm-identity';
import {
  assertNoMountsUnder,
  claimRecord,
  ensureRegistryDirectory,
  readRecord,
  removeExactDirectory,
  unmountVirtiofsdResources,
  writeRecord,
} from './cleanup-record-store';

export type { CleanupRegistryDependencies } from './cleanup-dependencies';

export type CloudHypervisorNetworkResource =
  'netns' | 'hostVeth' | 'namespaceVeth' | 'tap';

export interface CloudHypervisorCleanupHandle {
  captureNetworkPlan(plan: MicrovmNetworkPlan): Promise<void>;
  captureArtifactSnapshot(directory: string): Promise<void>;
  prepareVmmAccount(name: string): Promise<void>;
  captureVmmIdentity(identity: import('./vmm-identity').CloudHypervisorVmmIdentity): Promise<void>;
  prepareVmmAcl(path: string): Promise<void>;
  releaseVmmAcl(path: string): Promise<void>;
  captureNetworkResource(resource: CloudHypervisorNetworkResource): Promise<void>;
  captureRunDirectory(): Promise<void>;
  captureCgroup(): Promise<void>;
  captureVirtiofsdResources(): Promise<void>;
  prepareProcess(
    key: string,
    executable: string,
    socketPath: string,
    sourcePath?: string,
  ): Promise<void>;
  captureProcess(key: string, pid: number): Promise<void>;
  complete(): Promise<void>;
}

export interface CloudHypervisorCleanupRegistry {
  reapPending(
    ipPath: string,
    umountPath: string,
    vmmTools?: CloudHypervisorVmmIdentityToolPaths,
  ): Promise<void>;
  createPending(
    paths: CloudHypervisorRunPaths,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle>;
  create(
    paths: CloudHypervisorRunPaths,
    plan: MicrovmNetworkPlan,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle>;
}

/**
 * Orchestration facade over the focused cleanup modules: record persistence
 * (`cleanup-record-store`), network teardown (`cleanup-network`), VMM identity
 * teardown (`cleanup-vmm-identity`) and process teardown (`cleanup-process`).
 */
export class DurableCloudHypervisorCleanupRegistry implements CloudHypervisorCleanupRegistry {
  private readonly dependencies: ResolvedCleanupDependencies;

  constructor(dependencies: CleanupRegistryDependencies = {}) {
    this.dependencies = resolveCleanupDependencies(dependencies);
  }

  async reapPending(
    ipPath: string,
    umountPath: string,
    vmmTools?: CloudHypervisorVmmIdentityToolPaths,
  ): Promise<void> {
    await ensureRegistryDirectory(this.dependencies);
    const names = await this.dependencies.readdir(this.dependencies.rootDirectory);
    const errors: string[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) continue;
      const recordPath = path.join(this.dependencies.rootDirectory, name);
      try {
        const record = await readRecord(this.dependencies, recordPath);
        if (await processMatches(this.dependencies, record.owner)) continue;
        const release = await claimRecord(this.dependencies, recordPath);
        if (!release) continue;
        try {
          await this.reapRecord(recordPath, record, ipPath, umountPath, vmmTools);
        } finally {
          await release();
        }
      } catch (error) {
        errors.push(`${recordPath}: ${formatError(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Cloud Hypervisor stale cleanup is incomplete; retained recovery records: ${errors.join('; ')}`,
      );
    }
  }

  async create(
    paths: CloudHypervisorRunPaths,
    plan: MicrovmNetworkPlan,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle> {
    return this.createRecord(paths, plan, cloudHypervisorBinary, ipPath);
  }

  async createPending(
    paths: CloudHypervisorRunPaths,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle> {
    return this.createRecord(paths, undefined, cloudHypervisorBinary, ipPath);
  }

  private async createRecord(
    paths: CloudHypervisorRunPaths,
    plan: MicrovmNetworkPlan | undefined,
    cloudHypervisorBinary: string,
    ipPath: string,
  ): Promise<CloudHypervisorCleanupHandle> {
    await ensureRegistryDirectory(this.dependencies);
    assertSafeRecordPaths(paths, plan);
    const recordPath = path.join(this.dependencies.rootDirectory, `${paths.runId}.json`);
    const owner = await captureProcessIdentity(this.dependencies, this.dependencies.processId);
    const binary = await this.dependencies.realpath(cloudHypervisorBinary);
    const record: CleanupRecord = {
      version: CLEANUP_RECORD_VERSION,
      runId: paths.runId,
      owner,
      cloudHypervisorBinary: binary,
      paths: {
        runDirectory: paths.runDirectory,
        cgroupPath: paths.cgroupPath,
        virtiofsdShareDirectory: paths.virtiofsdShareDirectory,
      },
      ...(plan ? { network: {
        namespaceName: plan.namespaceName,
        netnsPath: plan.netnsPath,
        hostVethName: plan.hostVethName,
        namespaceVethName: plan.namespaceVethName,
        tapName: plan.tapName,
        infrastructureBridge: plan.infrastructureBridge,
        hostForwardRuleComment: plan.hostForwardRuleComment,
      } } : {}),
      identities: {},
      processes: {},
      mounts: [],
      updatedAt: new Date().toISOString(),
    };
    await writeRecord(this.dependencies, recordPath, record, true);
    return createCleanupHandle({
      recordPath,
      record,
      ipPath,
      persist: () => writeRecord(this.dependencies, recordPath, record, false),
      unlink: this.dependencies.unlink,
      realpath: this.dependencies.realpath,
      sleep: this.dependencies.sleep,
      pathExists: (filePath) => pathExists(filePath, this.dependencies.lstat),
      captureFileIdentity: (filePath) => captureFileIdentity(this.dependencies.lstat, filePath),
      captureInterfaceIdentity: (commandPath, name, namespace) =>
        captureInterfaceIdentity(this.dependencies.run, commandPath, name, namespace),
      captureProcessIdentity: (pid) => captureProcessIdentity(this.dependencies, pid),
      readMounts: () => readMounts(this.dependencies.readFile),
    });
  }

  private async reapRecord(
    recordPath: string,
    record: CleanupRecord,
    ipPath: string,
    umountPath: string,
    vmmTools?: CloudHypervisorVmmIdentityToolPaths,
  ): Promise<void> {
    await validateRecordResources(this.dependencies, record, ipPath);
    for (const [key, recorded] of Object.entries(record.processes)) {
      if (recorded.state === 'pending' || !recorded.identity) {
        throw new Error(`process "${key}" launch identity was never committed`);
      }
      if (await processMatches(this.dependencies, recorded.identity, recorded)) {
        await stopProcess(this.dependencies, recorded.identity, recorded);
      }
    }
    await unmountVirtiofsdResources(this.dependencies, record, umountPath);
    if (record.network) await deleteNetwork(this.dependencies, record, ipPath);
    await removeExactDirectory(
      record.paths.cgroupPath, record.identities.cgroup, this.dependencies, false,
    );
    await this.removeDirectoryTree(record.paths.runDirectory, record.identities.runDirectory);
    await this.removeDirectoryTree(
      record.paths.virtiofsdShareDirectory,
      record.identities.virtiofsdShareDirectory,
    );
    if (record.paths.artifactSnapshotDirectory) {
      await this.removeDirectoryTree(
        record.paths.artifactSnapshotDirectory,
        record.identities.artifactSnapshotDirectory,
      );
    }
    await deleteVmmIdentity(this.dependencies, record, vmmTools);
    await this.dependencies.unlink(recordPath);
  }

  private async removeDirectoryTree(
    directory: string,
    expected: FileIdentity | undefined,
  ): Promise<void> {
    await assertNoMountsUnder(this.dependencies, directory);
    await removeExactDirectory(directory, expected, this.dependencies, true);
  }
}
