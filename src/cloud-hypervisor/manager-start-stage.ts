import * as path from 'path';
import {
  prepareRunDirectory,
  stageArtifact,
  stageDiagnosticFile,
} from './diagnostics';
import { validateCloudHypervisorExports } from './exports';
import { hasReadOnlyWorkspaceMountPlan } from './filesystem-write-enforcement';
import type { CloudHypervisorCgroup } from './launcher';
import type {
  CloudHypervisorStartCheck,
  CloudHypervisorStartContext,
  CloudHypervisorStartResources,
} from './manager-start';
import type { CloudHypervisorStartNetwork } from './manager-start-network';

export async function stageCloudHypervisorStart(
  context: CloudHypervisorStartContext,
  resources: CloudHypervisorStartResources,
  network: CloudHypervisorStartNetwork,
  check: CloudHypervisorStartCheck,
): Promise<CloudHypervisorCgroup> {
  const { config, workDir, dependencies, paths, workloadProfile } = context;
  const { artifacts, cleanupRecord, identity, vmmIdentityManager } = resources;
  const { networkConfig, networkPlan } = network;
  const guestConfig = workloadProfile.guest;
  let rootfsSource = artifacts.rootfsPath;
  if (guestConfig) {
    validateCloudHypervisorExports(guestConfig.exports, {
      allowReadOnlyWorkspace: hasReadOnlyWorkspaceMountPlan(guestConfig.mountEnforcement),
      requireWorkspace: guestConfig.workspaceMount !== null,
      ...(guestConfig.workspaceMount === null ? { maxExports: 6 } : {}),
    });
    const rootfsPreparationDirectory = path.join(
      workDir, 'cloud-hypervisor-rootfs', paths.runId,
    );
    const rootfsPreparer = dependencies.createRootfsPreparer({
      runDirectory: rootfsPreparationDirectory,
      baseRootfsPath: artifacts.rootfsPath,
      supervisorBinaryPath: guestConfig.supervisorBinaryPath,
      supervisorSha256: guestConfig.supervisorSha256,
      supervisorGuestPath: '/usr/sbin/awf-supervisor',
      ...(!guestConfig.enclaveResources && config.scratchMib !== undefined
        ? { scratchMib: config.scratchMib }
        : {}),
      hostAliases: {
        ...(networkConfig?.apiProxyIp ? { 'api-proxy': networkConfig.apiProxyIp } : {}),
        ...(networkConfig?.hostAliases ?? {}),
      },
    }, artifacts.tools, (source, destination) =>
      dependencies.copySparseFile(artifacts.tools.rsync, source, destination));
    context.setRootfsPreparer(rootfsPreparer);
    rootfsSource = await check('rootfs', () => rootfsPreparer.prepare());
  }

  await check('run-directory', () => prepareRunDirectory(dependencies, paths, identity));
  await cleanupRecord.captureRunDirectory();
  const cgroup = dependencies.createCgroup(
    paths.cgroupPath,
    guestConfig?.enclaveResources
      ? {
          memoryMib: guestConfig.enclaveResources.memoryMiB,
          vcpuCount: guestConfig.enclaveResources.vcpuCount,
          cpuQuotaMilli: guestConfig.enclaveResources.cpuQuotaMilli,
          writableStorageBytes: guestConfig.enclaveResources.writableStorageBytes,
        }
      : { memoryMib: config.memoryMib, vcpuCount: config.vcpuCount },
  );
  context.setCgroup(cgroup);
  await check('cgroup', () => cgroup.setup());
  await cleanupRecord.captureCgroup();
  await check('kernel-stage', () => stageArtifact(dependencies, artifacts.kernelPath, paths.kernelPath, 0o400, identity));
  await check('rootfs-stage', () => stageArtifact(
    dependencies,
    rootfsSource,
    paths.rootfsPath,
    0o600,
    identity,
    () => dependencies.copySparseFile(
      artifacts.tools.rsync,
      rootfsSource,
      paths.rootfsPath,
    ),
  ));
  await stageDiagnosticFile(dependencies, paths.logPath, identity);
  await stageDiagnosticFile(dependencies, paths.serialLogPath, identity);
  await vmmIdentityManager.validateOwnedPaths([
    paths.runDirectory,
    paths.kernelPath,
    paths.rootfsPath,
    paths.logPath,
    paths.serialLogPath,
  ]);
  if (networkPlan) {
    await vmmIdentityManager.validateTapOwnership(
      artifacts.tools.ip,
      networkPlan.namespaceName,
      networkPlan.tapName,
    );
  }
  return cgroup;
}
