import * as path from 'path';
import type { ExecaChildProcess } from 'execa';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { MicrovmRootfsPreparer } from '../microvm/rootfs';
import type {
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
} from '../microvm/network';
import type { CloudHypervisorApiClient } from './api-client';
import {
  preserveVirtiofsdStartupEvidence,
} from './diagnostics';
import type { CloudHypervisorCgroup } from './launcher';
import {
  formatError,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorIdentity,
  type CloudHypervisorRunPaths,
} from './manager-types';
import type { VirtiofsdManager, VirtiofsdDevice } from './virtiofsd';
import type { BoundedOutputCapture } from './diagnostics';
import type { CloudHypervisorCleanupHandle } from './cleanup-registry';
import type { CloudHypervisorConfinementEvidence } from './confinement-verifier';
import type {
  CloudHypervisorVmmIdentity,
  CloudHypervisorVmmIdentityManager,
} from './vmm-identity';
import type { CloudHypervisorPreflightResult } from './preflight';
import type { CloudHypervisorNetworkLifecycle } from './network-namespace';
import {
  assertCloudHypervisorWorkloadLaunchable,
  type CloudHypervisorWorkloadProfile,
} from './workload-profile';
import type { HostPreflightCheck, HostPreflightReporter } from './host-preflight-progress';
import {
  resolveCloudHypervisorStartNetworkConfig,
  setupCloudHypervisorStartNetwork,
} from './manager-start-network';
import { stageCloudHypervisorStart } from './manager-start-stage';
import { launchCloudHypervisorStart } from './manager-start-launch';

export type CloudHypervisorStartCheck = <T>(
  id: HostPreflightCheck,
  operation: () => Promise<T> | T,
) => Promise<T> | T;

export interface CloudHypervisorStartResources {
  artifacts: CloudHypervisorPreflightResult;
  cleanupRecord: CloudHypervisorCleanupHandle;
  vmmIdentityManager: CloudHypervisorVmmIdentityManager;
  identity: CloudHypervisorVmmIdentity;
  guestIdentity: CloudHypervisorIdentity;
}

export interface CloudHypervisorStartContext {
  config: CloudHypervisorOptions;
  workDir: string;
  dependencies: CloudHypervisorManagerDependencies;
  paths: CloudHypervisorRunPaths;
  workloadProfile: CloudHypervisorWorkloadProfile;
  /** True only for the internal host-executor backend; user runtime selection never sets this. */
  allowTrustedEnclaveExecution?: boolean;
  verifiedArtifacts?: CloudHypervisorPreflightResult;
  launchReport?: HostPreflightReporter;
  managerStartReport?: HostPreflightReporter;
  stdoutCapture: BoundedOutputCapture;
  stderrCapture: BoundedOutputCapture;
  setNetworkPlan(plan: MicrovmNetworkPlan | undefined): void;
  setNetwork(network: MicrovmNetworkLifecycle | CloudHypervisorNetworkLifecycle | undefined): void;
  setRootfsPreparer(preparer: MicrovmRootfsPreparer | undefined): void;
  setCgroup(cgroup: CloudHypervisorCgroup | undefined): void;
  setVmmIdentity(identity: CloudHypervisorVmmIdentityManager | undefined): void;
  setProcess(process: ExecaChildProcess<string> | undefined): void;
  setClient(client: CloudHypervisorApiClient | undefined): void;
  setConfinementEvidence(evidence: CloudHypervisorConfinementEvidence | undefined): void;
  setVirtiofsd(virtiofsd: VirtiofsdManager | undefined): void;
  setFsDevices(devices: VirtiofsdDevice[]): void;
  setCleanupRecord(record: CloudHypervisorCleanupHandle | undefined): void;
  getFsDevices(): VirtiofsdDevice[];
  stop(): Promise<void>;
}

export async function startCloudHypervisor(
  context: CloudHypervisorStartContext,
): Promise<CloudHypervisorApiClient> {
  const {
    config, workDir, dependencies, paths, workloadProfile, verifiedArtifacts,
    managerStartReport,
    allowTrustedEnclaveExecution,
  } = context;
  assertCloudHypervisorWorkloadLaunchable(workloadProfile, allowTrustedEnclaveExecution);
  const guestConfig = workloadProfile.guest;
  const check: CloudHypervisorStartCheck = (id, operation) =>
    context.launchReport ? context.launchReport.check(id, operation) : operation();

  let startupError: unknown;
  try {
    const artifacts = verifiedArtifacts
      ?? await check('artifact-preflight', () => dependencies.preflight(config));
    const networkConfig = await resolveCloudHypervisorStartNetworkConfig(context, artifacts);
    const vmmTools = {
      getfacl: artifacts.tools.getfacl,
      getent: artifacts.tools.getent,
      groupdel: artifacts.tools.groupdel,
      id: artifacts.tools.id,
      ip: artifacts.tools.ip,
      setfacl: artifacts.tools.setfacl,
      useradd: artifacts.tools.useradd,
      userdel: artifacts.tools.userdel,
    };
    await check('recovery', () => dependencies.cleanupRegistry.reapPending(
      artifacts.tools.ip,
      artifacts.tools.umount,
      vmmTools,
    ));
    const guestIdentity = guestConfig?.identity ?? dependencies.resolveIdentity();
    const cleanupRecord = await dependencies.cleanupRegistry.createPending(
      paths,
      artifacts.cloudHypervisorBinary,
      artifacts.tools.ip,
    );
    context.setCleanupRecord(cleanupRecord);
    await cleanupRecord.captureArtifactSnapshot(artifacts.artifactSnapshotDirectory);
    const vmmIdentityManager = dependencies.createVmmIdentity(paths.runId, vmmTools, {
      prepareAccount: (name) => cleanupRecord.prepareVmmAccount(name),
      captureIdentity: (identity) => cleanupRecord.captureVmmIdentity(identity),
      prepareAcl: (aclPath, baseline, temporaryUids) =>
        cleanupRecord.prepareVmmAcl(aclPath, baseline, temporaryUids),
      releaseAcl: (aclPath) => cleanupRecord.releaseVmmAcl(aclPath),
    });
    context.setVmmIdentity(vmmIdentityManager);
    const identity = await check('identity', () => vmmIdentityManager.allocate());
    const resources: CloudHypervisorStartResources = {
      artifacts, cleanupRecord, vmmIdentityManager, identity, guestIdentity,
    };
    const network = await setupCloudHypervisorStartNetwork(context, resources, networkConfig, check);
    const cgroup = await stageCloudHypervisorStart(context, resources, network, check);
    return await launchCloudHypervisorStart(context, resources, network, cgroup, check);
  } catch (error) {
    startupError = error;
  }

  managerStartReport?.fail('manager-start', startupError);

  const startupEvidenceDirectory = path.join(
    workDir,
    'diagnostics',
    'cloud-hypervisor',
    `startup-${paths.runId}`,
  );
  try {
    await preserveVirtiofsdStartupEvidence(
      dependencies,
      context.getFsDevices(),
      startupEvidenceDirectory,
    );
  } catch (evidenceError) {
    startupError = new Error(
      `${formatError(startupError)}; preserving virtiofsd confinement evidence failed: ` +
      formatError(evidenceError),
    );
  }
  try {
    if (context.launchReport) {
      await context.launchReport.fork('host-invocation-cleanup').check('manager-stop', () => context.stop());
    } else {
      await context.stop();
    }
  } catch (cleanupError) {
    throw new Error(
      `Cloud Hypervisor startup failed: ${formatError(startupError)}; ` +
      `partial-start cleanup also failed: ${formatError(cleanupError)}`,
    );
  }
  throw startupError;
}
