import { promises as fs } from 'fs';
import execa from 'execa';
import type { MicrovmNetworkPlan } from '../microvm/network';
import * as capture from './cleanup-capture';
import { captureProcessIdentity, sameProcess } from './cleanup-process-identity';
import {
  NVX_CLEANUP_SCHEMA_VERSION,
  type NvxCleanupDeviceAclIdentity,
  type NvxCleanupProcessIdentity,
  type NvxCleanupRecord,
} from './cleanup-record';
import { NvxCleanupStore, type NvxCleanupStoreDependencies } from './cleanup-store';
import {
  processMatches,
  removeExactDirectory,
  removeExactFile,
  removeIdentity,
  removeNetwork,
  stopRecordedProcesses,
} from './cleanup-teardown';
import { createNvxRunLayout, type NvxRunLayout } from './run-layout';
import {
  withNvxDeviceAclLock,
  type NvxVmmIdentity,
} from './runtime-lifecycle';

export interface NvxCleanupToolPaths {
  readonly getent: string;
  readonly groupdel: string;
  readonly id: string;
  readonly ip: string;
  readonly iptables: string;
  readonly setfacl: string;
  readonly userdel: string;
}

export interface NvxCleanupRegistryDependencies {
  readonly store: NvxCleanupStore;
  readonly pid: number;
  lstat: typeof fs.lstat;
  stat: typeof fs.stat;
  readFile: typeof fs.readFile;
  readlink: typeof fs.readlink;
  rm: typeof fs.rm;
  rmdir: typeof fs.rmdir;
  kill: typeof process.kill;
  sleep(milliseconds: number): Promise<void>;
  withDeviceAclLock<T>(operation: () => Promise<T>): Promise<T>;
  run(command: string, args: readonly string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface NvxCleanupHandle {
  readonly record: NvxCleanupRecord;
  captureArtifactSnapshot(directory: string): Promise<void>;
  prepareAccount(name: string): Promise<void>;
  captureIdentity(identity: NvxVmmIdentity): Promise<void>;
  prepareDeviceAcl(identity: NvxCleanupDeviceAclIdentity): Promise<void>;
  releaseDeviceAcl(identity: NvxCleanupDeviceAclIdentity): Promise<void>;
  captureNetworkPlan(plan: MicrovmNetworkPlan): Promise<void>;
  captureNetworkResource(resource: 'netns' | 'hostVeth' | 'namespaceVeth' | 'tap'): Promise<void>;
  captureRunDirectory(): Promise<void>;
  captureCgroup(): Promise<void>;
  captureProcess(kind: 'launcher' | 'openvmm', pid: number): Promise<NvxCleanupProcessIdentity>;
  captureMountNamespace(inode: string): Promise<void>;
  complete(): Promise<void>;
}

export interface NvxCleanupRegistry {
  reapPending(tools: NvxCleanupToolPaths): Promise<void>;
  createPending(runId: string, ipPath?: string): Promise<NvxCleanupHandle>;
}

function defaultDependencies(): NvxCleanupRegistryDependencies {
  const processMatches = async (identity: NvxCleanupProcessIdentity): Promise<boolean> => {
    try {
      const current = await captureProcessIdentity(process.pid === identity.pid
        ? process.pid
        : identity.pid);
      return sameProcess(current, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const storeDependencies: Partial<NvxCleanupStoreDependencies> = { processMatches };
  return {
    store: new NvxCleanupStore(storeDependencies),
    pid: process.pid,
    lstat: fs.lstat,
    stat: fs.stat,
    readFile: fs.readFile,
    readlink: fs.readlink,
    rm: fs.rm,
    rmdir: fs.rmdir,
    kill: process.kill,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    withDeviceAclLock: withNvxDeviceAclLock,
    run: async (command, args) => {
      const result = await execa(command, [...args], {
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        extendEnv: false,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export class DurableNvxCleanupRegistry implements NvxCleanupRegistry {
  constructor(
    private readonly dependencies: NvxCleanupRegistryDependencies = defaultDependencies(),
  ) {}

  async createPending(runId: string, ipPath = '/usr/sbin/ip'): Promise<NvxCleanupHandle> {
    const layout = createNvxRunLayout(runId);
    const record: NvxCleanupRecord = {
      schemaVersion: NVX_CLEANUP_SCHEMA_VERSION,
      runId,
      owner: await captureProcessIdentity(this.dependencies.pid, this.dependencies),
      resources: { deviceAcls: [] },
      stages: {
        accountCreated: false,
        artifactSnapshotCreated: false,
        cgroupCreated: false,
        deviceAclsGranted: false,
        networkCreated: false,
        processStarted: false,
        runDirectoryCreated: false,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.dependencies.store.create(record);
    return this.createHandle(layout, record, ipPath);
  }

  async reapPending(tools: NvxCleanupToolPaths): Promise<void> {
    const errors: string[] = [];
    for (const recordPath of await this.dependencies.store.list()) {
      try {
        const record = await this.dependencies.store.read(recordPath);
        if (await processMatches(record.owner, this.dependencies)) continue;
        const owner = await captureProcessIdentity(this.dependencies.pid, this.dependencies);
        const release = await this.dependencies.store.claim(recordPath, owner);
        if (!release) continue;
        try {
          await this.cleanupRecord(record, tools);
          await this.dependencies.store.remove(record.runId);
        } finally {
          await release();
        }
      } catch (error) {
        errors.push(`${recordPath}: ${formatError(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`NVX stale cleanup is incomplete; retained records: ${errors.join('; ')}`);
    }
  }

  private createHandle(
    layout: NvxRunLayout,
    record: NvxCleanupRecord,
    ipPath: string,
  ): NvxCleanupHandle {
    const update = <T>(operation: () => T | Promise<T>): Promise<T> =>
      this.updateRecord(record, operation);
    return {
      record,
      captureArtifactSnapshot: (directory) => update(() =>
        capture.captureArtifactSnapshot(record, layout, directory, this.dependencies)),
      prepareAccount: (name) => update(() => capture.prepareAccount(record, name)),
      captureIdentity: (identity) => update(() => capture.captureIdentity(record, identity)),
      prepareDeviceAcl: (identity) => update(() => capture.prepareDeviceAcl(record, identity)),
      releaseDeviceAcl: (identity) => update(() => capture.releaseDeviceAcl(record, identity)),
      captureNetworkPlan: (plan) => update(() =>
        capture.captureNetworkPlan(record, layout, plan, this.dependencies)),
      captureNetworkResource: (resource) => update(() =>
        capture.captureNetworkResource(record, resource, ipPath, this.dependencies)),
      captureRunDirectory: () => update(() =>
        capture.captureRunDirectory(record, layout, this.dependencies)),
      captureCgroup: () => update(() => capture.captureCgroup(record, layout, this.dependencies)),
      captureProcess: (kind, pid) => update(() =>
        capture.captureProcess(record, kind, pid, this.dependencies)),
      captureMountNamespace: (inode) => update(() => capture.captureMountNamespace(record, inode)),
      complete: () => this.dependencies.store.remove(record.runId),
    };
  }

  private async updateRecord<T>(
    record: NvxCleanupRecord,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const result = await operation();
    record.updatedAt = new Date().toISOString();
    await this.dependencies.store.update(record);
    return result;
  }

  private async cleanupRecord(record: NvxCleanupRecord, tools: NvxCleanupToolPaths): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(() => stopRecordedProcesses(record, this.dependencies));
    await attempt(() => removeNetwork(record, tools.ip, tools.iptables, this.dependencies));
    await attempt(() => removeExactFile(record.resources.networkReservation, this.dependencies));
    await attempt(() => removeExactDirectory(record.resources.cgroup, false, this.dependencies));
    await attempt(() => removeExactDirectory(record.resources.runDirectory, true, this.dependencies));
    await attempt(() =>
      removeExactDirectory(record.resources.artifactSnapshot, true, this.dependencies));
    await attempt(() => removeIdentity(record, tools, this.dependencies));
    if (errors.length > 0) throw new Error(errors.map(formatError).join('; '));
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
