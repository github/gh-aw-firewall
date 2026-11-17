import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import type { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import type { CloudHypervisorArtifactSnapshot } from './artifact-snapshot';
import type { HostEnclaveExecutorDependencies, HostEnclaveExecutorManager } from './enclave-executor-types';
import type { HostPreflightReporter } from './host-preflight-progress';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';

export type InvocationCheck = <T>(
  id: Parameters<HostPreflightReporter['check']>[0],
  operation: () => Promise<T>,
) => Promise<T>;

/** Resources are published as soon as acquired, including work that outlives interruption. */
export class HostEnclaveInvocationResources {
  mounted = false;
  invocationDirectoryCreated = false;
  snapshot?: CloudHypervisorArtifactSnapshot;
  manager?: HostEnclaveExecutorManager;
  managerStopped = false;
  storage?: Awaited<ReturnType<NonNullable<HostEnclaveExecutorDependencies['prepareInvocationStorage']>>>;
  journal?: Awaited<ReturnType<HostEnclaveExecutorDependencies['createResourceJournal']>>;
  private readonly pendingWork = new Set<Promise<unknown>>();
  private stopPromise?: Promise<void>;
  private filesystemCleanupPromise?: Promise<void>;

  constructor(
    readonly plan: HostExecutorInvocationPlan,
    public dependencies: HostEnclaveExecutorDependencies,
    private readonly tools: CloudHypervisorHostToolPaths,
    private readonly diagnostic: Pick<HostExecutorInvocationDiagnostics, 'milestone'>,
  ) {}

  track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.pendingWork.delete(tracked));
    this.pendingWork.add(tracked);
    return tracked;
  }

  async stopManager(): Promise<void> {
    if (!this.manager) return;
    if (!this.stopPromise) {
      this.diagnostic.milestone('manager-stop-start');
      this.stopPromise = this.manager.stop().then(() => { this.diagnostic.milestone('manager-stop-complete'); });
    }
    try {
      await this.stopPromise;
    } catch (error) {
      this.stopPromise = undefined;
      throw error;
    }
  }

  async drainAndStop(check: InvocationCheck): Promise<unknown> {
    // Startup and staging may still publish resources after an interruption.
    await check('pending-work', () => Promise.allSettled([...this.pendingWork]));
    if (this.manager && this.stopPromise) {
      await this.stopPromise.catch(() => undefined);
      this.stopPromise = undefined;
    }
    let error: unknown;
    if (this.manager && !this.managerStopped) {
      try {
        await check('manager-stop', () => this.stopManager());
        this.managerStopped = true;
      } catch (caught) {
        error = caught;
      }
    }
    if (this.manager && this.managerStopped) {
      try {
        await check('manager-record', () => this.manager!.completeCleanupRecord());
      } catch (caught) {
        error = error ? new Error(`${String(error)}; ${String(caught)}`) : caught;
      }
    }
    return error;
  }

  private cleanupInvocationFilesystem(): Promise<void> {
    if (this.filesystemCleanupPromise) return this.filesystemCleanupPromise;
    this.filesystemCleanupPromise = (async () => {
      if (this.mounted) {
        if (this.storage) {
          await this.dependencies.verifyStorage(this.plan.invocationHostDir,
            CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[this.plan.executorKind].writableStorageBytes);
        }
        await this.journal?.verifyMount();
        await this.dependencies.unmount(this.plan.invocationHostDir, this.tools);
        this.mounted = false;
        await this.journal?.verifyDirectory();
        await this.dependencies.rm(this.plan.invocationHostDir, { recursive: true, force: true });
        this.invocationDirectoryCreated = false;
      } else if (this.invocationDirectoryCreated) {
        await this.journal?.verifyDirectory();
        await this.dependencies.rm(this.plan.invocationHostDir, { recursive: true, force: true });
        this.invocationDirectoryCreated = false;
      }
    })().catch((error) => {
      this.filesystemCleanupPromise = undefined;
      throw error;
    });
    return this.filesystemCleanupPromise;
  }

  async removeResources(check: InvocationCheck, error: unknown, originalDependencies: HostEnclaveExecutorDependencies): Promise<unknown> {
    if (this.snapshot && (!this.manager || this.managerStopped) && error === undefined) {
      try {
        await check('snapshot-remove', async () => {
          await this.journal?.verifySnapshot();
          await this.dependencies.removeArtifactSnapshot(this.snapshot!.directory);
        });
      } catch (caught) {
        error = error ? new Error(`${String(error)}; ${String(caught)}`) : caught;
      }
    }
    if ((!this.manager || this.managerStopped) && error === undefined) {
      try {
        await check('filesystem-remove', () => this.cleanupInvocationFilesystem());
        await check('storage-close', async () => this.storage?.close());
        await check('journal-complete', async () => this.journal?.complete());
      } catch (caught) {
        error = error ? new Error(`${String(error)}; ${String(caught)}`) : caught;
      }
    } else if (error === undefined && this.invocationDirectoryCreated && !this.mounted) {
      try {
        await check('filesystem-remove', async () => {
          await this.journal?.verifyDirectory();
          await originalDependencies.rm(this.plan.invocationHostDir, { recursive: true, force: true });
        });
      } catch (caught) {
        error = caught;
      }
    }
    return error;
  }
}
