import type { HostExecutorRunState } from '../enclave/host-executor-server';
import type { HostExecutorResourceJournal } from '../enclave/host-executor-resource-journal';
import { hostExecutorVmRunId } from '../enclave/host-executor-journal';
import { calculateSha256 } from './artifact-trust';
import type { HostExecutorAgentPolicy, VerifiedCloudHypervisorEnclaveArtifacts } from './enclave-executor-types';
import { resolveCloudHypervisorEnclaveExportPlan } from './enclave-export-plan';
import { prepareInvocationFilesystem, stageInvocationInputs } from './enclave-invocation-staging';
import type { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import { createWorkloadProfile } from './host-enclave-executor-policy';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';
import type { CloudHypervisorCommonPreflightResult, CloudHypervisorPreflightResult } from './preflight';

export async function stageHostEnclaveInvocation(
  resources: HostEnclaveInvocationResources,
  inputs: {
    run: HostExecutorRunState;
    preflight: CloudHypervisorCommonPreflightResult;
    enclaveArtifacts: VerifiedCloudHypervisorEnclaveArtifacts;
    policy: HostExecutorAgentPolicy | undefined;
    publicDebug: boolean;
  },
  progress: {
    report: HostPreflightReporter;
    check: <T>(id: Parameters<HostPreflightReporter['check']>[0], operation: () => Promise<T> | T) => Promise<T>;
    race: <T>(operation: Promise<T>) => Promise<T>;
    assertActive: () => void;
    resourcePublished: () => void;
  },
): Promise<{ artifacts: CloudHypervisorPreflightResult; profile: ReturnType<typeof createWorkloadProfile> }> {
  const { run, preflight, enclaveArtifacts, policy, publicDebug } = inputs;
  const { report, check, race, assertActive, resourcePublished } = progress;
  const { plan } = resources;
  const runId = hostExecutorVmRunId(plan);
  const role = plan.executorKind;
  const originalDependencies = resources.dependencies;
  const verifiedRootfs = enclaveArtifacts.rootfs[enclaveArtifacts.manifest.schemaVersion === 2 ? 'script' : role];
  await check('filesystem', () => race(resources.track(prepareInvocationFilesystem(
    run, plan, role,
    {
      ...resources.dependencies,
      mountTmpfs: (...args) => resources.dependencies.mountTmpfs(...args),
      verifyStorage: (...args) => resources.dependencies.verifyStorage(...args),
    },
    preflight.tools,
    async () => {
      resources.journal = await originalDependencies.createResourceJournal(run, plan, runId);
      if (publicDebug) await resources.journal.publicDebugRetention?.(true);
      resourcePublished();
      if (originalDependencies.prepareInvocationStorage) {
        resources.storage = await originalDependencies.prepareInvocationStorage(
          run, plan, resources.journal as HostExecutorResourceJournal, preflight.tools,
          report.fork('bounded-runtime'),
        );
        resources.dependencies = { ...resources.dependencies, ...resources.storage.dependencies };
      }
    },
    async () => {
      resources.invocationDirectoryCreated = true;
      await resources.journal?.captureDirectory();
    },
    async () => {
      resources.mounted = true;
      await resources.journal?.captureMount();
    },
  ))));
  assertActive();
  const exportPlan = await check('export-plan', () => race(resolveCloudHypervisorEnclaveExportPlan({
    runId: run.runId, seedsDir: run.seedsDir, invocationsDir: run.invocationsDir, entries: run.entries,
  }, plan)));
  resources.snapshot = await check('snapshot', async () => {
    await resources.journal?.prepareSnapshot();
    const snapshotPromise = resources.track(resources.dependencies.createArtifactSnapshot({
      cloudHypervisorBinary: preflight.cloudHypervisorBinary,
      virtiofsdBinary: preflight.virtiofsdBinary,
      kernelPath: preflight.kernelPath,
      rootfsPath: verifiedRootfs.path,
      supervisorPath: preflight.supervisorPath,
      manifestPath: enclaveArtifacts.manifestPath,
      bundlePath: enclaveArtifacts.manifestBundlePath,
    }, (source, destination) => resources.dependencies.copySparseFile(preflight.tools.rsync, source, destination),
    async (directory) => resources.journal?.captureSnapshot(directory),
    report.fork('artifact-snapshot')).then(async (created) => {
      resources.snapshot = created;
      await resources.journal?.captureSnapshot(created.directory);
      return created;
    }));
    return race(snapshotPromise);
  });
  const createdSnapshot = resources.snapshot;
  if (!('rootfsPath' in createdSnapshot) || typeof createdSnapshot.rootfsPath !== 'string') {
    throw new Error('Enclave invocation rootfs snapshot is missing');
  }
  await check('snapshot-digest', async () => {
    const stat = await race(resources.dependencies.lstat(createdSnapshot.rootfsPath));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== verifiedRootfs.artifact.sizeBytes
      || await race(calculateSha256(createdSnapshot.rootfsPath)) !== verifiedRootfs.artifact.sha256) {
      throw markHostPreflightError(
        new Error('Enclave rootfs snapshot does not match its attested artifact digest'), 'digest-mismatch');
    }
    if (resources.storage) {
      for (const [file, digest] of [
        [createdSnapshot.cloudHypervisorBinary, preflight.artifactDigests.cloudHypervisor],
        [createdSnapshot.virtiofsdBinary, preflight.artifactDigests.virtiofsd],
        [createdSnapshot.kernelPath, preflight.artifactDigests.kernel],
        [createdSnapshot.supervisorPath, preflight.artifactDigests.supervisor],
      ]) {
        if (!digest || await calculateSha256(file!) !== digest) {
          throw markHostPreflightError(new Error('Invocation artifact digest changed'), 'digest-mismatch');
        }
      }
    }
  });
  assertActive();
  const artifacts: CloudHypervisorPreflightResult = {
    ...preflight,
    cloudHypervisorBinary: createdSnapshot.cloudHypervisorBinary,
    virtiofsdBinary: createdSnapshot.virtiofsdBinary,
    kernelPath: createdSnapshot.kernelPath,
    rootfsPath: createdSnapshot.rootfsPath,
    supervisorPath: createdSnapshot.supervisorPath,
    artifactSnapshotDirectory: createdSnapshot.directory,
    artifactDigests: {
      ...preflight.artifactDigests,
      rootfs: verifiedRootfs.artifact.sha256,
      supervisor: preflight.artifactDigests.supervisor,
    },
  };
  const profile = await check('workload-profile', () => createWorkloadProfile(
    plan, exportPlan, artifacts, policy, publicDebug,
  ));
  await check('input-staging', () => race(resources.track(
    stageInvocationInputs(plan, role, policy, resources.dependencies),
  )));
  return { artifacts, profile };
}
