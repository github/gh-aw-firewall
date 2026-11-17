import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import type { HostExecutorResourceJournal } from '../enclave/host-executor-resource-journal';
import type { CloudHypervisorArtifactSnapshot } from './artifact-snapshot';
import { calculateSha256 } from './artifact-trust';
import type { HostEnclaveExecutorDependencies, HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts } from './enclave-executor-types';
import { prepareInvocationFilesystem, stageInvocationInputs } from './enclave-invocation-staging';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';
import type { CloudHypervisorCommonPreflightResult, CloudHypervisorPreflightResult } from './preflight';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';

export class HostEnclaveInvocationFilesystem {
  mounted = false;
  invocationDirectoryCreated = false;
  snapshot: CloudHypervisorArtifactSnapshot | undefined;
  storage: Awaited<ReturnType<NonNullable<HostEnclaveExecutorDependencies['prepareInvocationStorage']>>> | undefined;
  journal: Awaited<ReturnType<HostEnclaveExecutorDependencies['createResourceJournal']>> | undefined;
  dependencies: HostEnclaveExecutorDependencies;
  private readonly pendingWork = new Set<Promise<unknown>>();
  private cleanupPromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      readonly runState: HostExecutorRunState;
      readonly plan: HostExecutorInvocationPlan;
      readonly runId: string;
      readonly preflight: CloudHypervisorCommonPreflightResult;
      readonly enclaveArtifacts: VerifiedCloudHypervisorEnclaveArtifacts;
      readonly retainPublicDebug: boolean;
    },
    dependencies: HostEnclaveExecutorDependencies,
  ) {
    this.dependencies = dependencies;
  }

  prepare(report: HostPreflightReporter, onResourcePublished: () => void): Promise<void> {
    const { runState, plan, runId, preflight } = this.options;
    const dependencies = this.dependencies;
    return prepareInvocationFilesystem(
      runState,
      plan,
      plan.executorKind,
      {
        ...dependencies,
        mountTmpfs: (...args) => this.dependencies.mountTmpfs(...args),
        verifyStorage: (...args) => this.dependencies.verifyStorage(...args),
      },
      preflight.tools,
      async () => {
        this.journal = await dependencies.createResourceJournal(runState, plan, runId);
        if (this.options.retainPublicDebug) await this.journal.publicDebugRetention?.(true);
        onResourcePublished();
        if (dependencies.prepareInvocationStorage) {
          this.storage = await dependencies.prepareInvocationStorage(
            runState, plan, this.journal as HostExecutorResourceJournal, preflight.tools,
            report.fork('bounded-runtime'),
          );
          this.dependencies = { ...this.dependencies, ...this.storage.dependencies };
        }
      },
      async () => {
        this.invocationDirectoryCreated = true;
        await this.journal?.captureDirectory();
      },
      async () => {
        this.mounted = true;
        await this.journal?.captureMount();
      },
    );
  }

  createSnapshot(report: HostPreflightReporter): Promise<CloudHypervisorArtifactSnapshot> {
    const { preflight, enclaveArtifacts, plan } = this.options;
    const verifiedRootfs = enclaveArtifacts.rootfs[
      enclaveArtifacts.manifest.schemaVersion === 2 ? 'script' : plan.executorKind
    ];
    const dependencies = this.dependencies;
    return this.track(dependencies.createArtifactSnapshot({
      cloudHypervisorBinary: preflight.cloudHypervisorBinary,
      virtiofsdBinary: preflight.virtiofsdBinary,
      kernelPath: preflight.kernelPath,
      rootfsPath: verifiedRootfs.path,
      supervisorPath: preflight.supervisorPath,
      manifestPath: enclaveArtifacts.manifestPath,
      bundlePath: enclaveArtifacts.manifestBundlePath,
    }, (source, destination) => dependencies.copySparseFile(
      preflight.tools.rsync, source, destination,
    ), async (directory) => this.journal?.captureSnapshot(directory),
    report.fork('artifact-snapshot')).then(async (created) => {
      this.snapshot = created;
      await this.journal?.captureSnapshot(created.directory);
      return created;
    }));
  }

  async verifySnapshot(
    snapshot: CloudHypervisorArtifactSnapshot,
    raceInterruption: <T>(operation: Promise<T>) => Promise<T>,
  ): Promise<CloudHypervisorPreflightResult> {
    const { preflight, enclaveArtifacts, plan } = this.options;
    const verifiedRootfs = enclaveArtifacts.rootfs[
      enclaveArtifacts.manifest.schemaVersion === 2 ? 'script' : plan.executorKind
    ];
    const dependencies = this.dependencies;
    const stat = await raceInterruption(dependencies.lstat(snapshot.rootfsPath));
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size !== verifiedRootfs.artifact.sizeBytes ||
      await raceInterruption(calculateSha256(snapshot.rootfsPath)) !== verifiedRootfs.artifact.sha256
    ) {
      throw markHostPreflightError(
        new Error('Enclave rootfs snapshot does not match its attested artifact digest'), 'digest-mismatch');
    }
    if (this.storage) {
      for (const [file, digest] of [
        [snapshot.cloudHypervisorBinary, preflight.artifactDigests.cloudHypervisor],
        [snapshot.virtiofsdBinary, preflight.artifactDigests.virtiofsd],
        [snapshot.kernelPath, preflight.artifactDigests.kernel],
        [snapshot.supervisorPath, preflight.artifactDigests.supervisor],
      ]) {
        if (!digest || await calculateSha256(file!) !== digest) {
          throw markHostPreflightError(new Error('Invocation artifact digest changed'), 'digest-mismatch');
        }
      }
    }
    return {
      ...preflight,
      cloudHypervisorBinary: snapshot.cloudHypervisorBinary,
      virtiofsdBinary: snapshot.virtiofsdBinary,
      kernelPath: snapshot.kernelPath,
      rootfsPath: snapshot.rootfsPath,
      supervisorPath: snapshot.supervisorPath,
      artifactSnapshotDirectory: snapshot.directory,
      artifactDigests: {
        ...preflight.artifactDigests,
        rootfs: verifiedRootfs.artifact.sha256,
        supervisor: preflight.artifactDigests.supervisor,
      },
    };
  }

  stageInputs(policy: HostExecutorAgentPolicy | undefined): Promise<void> {
    const { plan } = this.options;
    return this.track(stageInvocationInputs(plan, plan.executorKind, policy, this.dependencies));
  }

  track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.pendingWork.delete(tracked));
    this.pendingWork.add(tracked);
    return tracked;
  }

  drain(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled([...this.pendingWork]);
  }

  async removeSnapshot(): Promise<void> {
    await this.journal?.verifySnapshot();
    await this.dependencies.removeArtifactSnapshot(this.snapshot!.directory);
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      const { plan, preflight } = this.options;
      if (this.mounted) {
        if (this.storage) {
          await this.dependencies.verifyStorage(plan.invocationHostDir,
            CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[plan.executorKind].writableStorageBytes);
        }
        await this.journal?.verifyMount();
        await this.dependencies.unmount(plan.invocationHostDir, preflight.tools);
        this.mounted = false;
        await this.removeDirectory();
      } else if (this.invocationDirectoryCreated) {
        await this.removeDirectory();
      }
    })().catch((error) => {
      this.cleanupPromise = undefined;
      throw error;
    });
    return this.cleanupPromise;
  }

  private async removeDirectory(): Promise<void> {
    await this.journal?.verifyDirectory();
    await this.dependencies.rm(this.options.plan.invocationHostDir, { recursive: true, force: true });
    this.invocationDirectoryCreated = false;
  }
}
