import * as path from 'path';
import type { ExecaChildProcess } from 'execa';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { MicrovmRootfsPreparer } from '../microvm/rootfs';
import {
  createMicrovmNetworkPlan,
  type MicrovmNetworkLifecycle,
  type MicrovmNetworkPlan,
} from '../microvm/network';
import type { CloudHypervisorApiClient } from './api-client';
import {
  prepareRunDirectory,
  preserveVirtiofsdStartupEvidence,
  stageArtifact,
  stageDiagnosticFile,
  waitForApiSocket,
} from './diagnostics';
import {
  CloudHypervisorCgroup,
  buildCloudHypervisorLaunchCommand,
} from './launcher';
import {
  formatError,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorManagerGuestConfig,
  type CloudHypervisorManagerNetworkConfig,
  type CloudHypervisorRunPaths,
} from './manager-types';
import { validateCloudHypervisorExports } from './exports';
import { hasReadOnlyWorkspaceMountPlan } from './filesystem-write-enforcement';
import type { VirtiofsdManager, VirtiofsdDevice } from './virtiofsd';
import { buildCloudHypervisorVmConfig } from './vm-config-builder';
import type { BoundedOutputCapture } from './diagnostics';
import type { CloudHypervisorConfinementEvidence } from './confinement-verifier';
import type { CloudHypervisorVmmIdentityManager } from './vmm-identity';

export interface CloudHypervisorStartContext {
  config: CloudHypervisorOptions;
  workDir: string;
  dependencies: CloudHypervisorManagerDependencies;
  paths: CloudHypervisorRunPaths;
  networkConfig?: CloudHypervisorManagerNetworkConfig;
  guestConfig?: CloudHypervisorManagerGuestConfig;
  stdoutCapture: BoundedOutputCapture;
  stderrCapture: BoundedOutputCapture;
  setNetworkPlan(plan: MicrovmNetworkPlan | undefined): void;
  setNetwork(network: MicrovmNetworkLifecycle | undefined): void;
  setRootfsPreparer(preparer: MicrovmRootfsPreparer | undefined): void;
  setCgroup(cgroup: CloudHypervisorCgroup | undefined): void;
  setVmmIdentity(identity: CloudHypervisorVmmIdentityManager | undefined): void;
  setProcess(process: ExecaChildProcess<string> | undefined): void;
  setClient(client: CloudHypervisorApiClient | undefined): void;
  setConfinementEvidence(evidence: CloudHypervisorConfinementEvidence | undefined): void;
  setVirtiofsd(virtiofsd: VirtiofsdManager | undefined): void;
  setFsDevices(devices: VirtiofsdDevice[]): void;
  getFsDevices(): VirtiofsdDevice[];
  stop(): Promise<void>;
}

export async function startCloudHypervisor(
  context: CloudHypervisorStartContext,
): Promise<CloudHypervisorApiClient> {
  const {
    config, workDir, dependencies, paths, networkConfig, guestConfig,
  } = context;
  if (!networkConfig) {
    throw new Error(
      'Cloud Hypervisor network configuration is required; refusing to launch an unfiltered microVM',
    );
  }

  let startupError: unknown;
  try {
    const artifacts = await dependencies.preflight(config);
    const guestIdentity = guestConfig?.identity ?? dependencies.resolveIdentity();
    const vmmIdentityManager = dependencies.createVmmIdentity(paths.runId, {
      getfacl: artifacts.tools.getfacl,
      getent: artifacts.tools.getent,
      groupdel: artifacts.tools.groupdel,
      id: artifacts.tools.id,
      ip: artifacts.tools.ip,
      setfacl: artifacts.tools.setfacl,
      useradd: artifacts.tools.useradd,
      userdel: artifacts.tools.userdel,
    });
    context.setVmmIdentity(vmmIdentityManager);
    const identity = await vmmIdentityManager.allocate();
    const networkPlan = createMicrovmNetworkPlan(paths.runId, {
      ...networkConfig,
      tapOwnerUid: identity.uid,
      tapOwnerGid: identity.gid,
      tapVnetHdr: true,
    });
    context.setNetworkPlan(networkPlan);
    const network = dependencies.createNetwork(networkPlan, artifacts.tools);
    context.setNetwork(network);
    await network.setup();
    let rootfsSource = artifacts.rootfsPath;
    if (guestConfig) {
      validateCloudHypervisorExports(guestConfig.exports, {
        allowReadOnlyWorkspace: hasReadOnlyWorkspaceMountPlan(guestConfig.mountEnforcement),
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
        hostAliases: {
          ...(networkConfig.apiProxyIp ? { 'api-proxy': networkConfig.apiProxyIp } : {}),
          ...(networkConfig.hostAliases ?? {}),
        },
      }, artifacts.tools);
      context.setRootfsPreparer(rootfsPreparer);
      rootfsSource = await rootfsPreparer.prepare();
    }

    await prepareRunDirectory(dependencies, paths, identity);
    const cgroup = dependencies.createCgroup(
      paths.cgroupPath,
      { memoryMib: config.memoryMib, vcpuCount: config.vcpuCount },
    );
    context.setCgroup(cgroup);
    await cgroup.setup();
    await stageArtifact(dependencies, artifacts.kernelPath, paths.kernelPath, 0o400, identity);
    await stageArtifact(dependencies, rootfsSource, paths.rootfsPath, 0o600, identity);
    await stageDiagnosticFile(dependencies, paths.logPath, identity);
    await stageDiagnosticFile(dependencies, paths.serialLogPath, identity);
    await vmmIdentityManager.validateOwnedPaths([
      paths.runDirectory,
      paths.kernelPath,
      paths.rootfsPath,
      paths.logPath,
      paths.serialLogPath,
    ]);
    await vmmIdentityManager.validateTapOwnership(
      artifacts.tools.ip,
      networkPlan.namespaceName,
      networkPlan.tapName,
    );
    await vmmIdentityManager.grantDeviceAccess();

    const launchCommand = buildCloudHypervisorLaunchCommand({
      tools: { ip: artifacts.tools.ip, setpriv: artifacts.tools.setpriv },
      namespaceName: networkPlan.namespaceName,
      identity,
      cloudHypervisorBinary: config.cloudHypervisorBinary,
      apiSocketPath: paths.apiSocketPath,
      logFilePath: paths.logPath,
    });
    const child = dependencies.launch(launchCommand.command, [...launchCommand.args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Cloud Hypervisor directly processes untrusted guest/device input, so
      // its environment must not expose the host's provider credentials.
      extendEnv: false,
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    context.setProcess(child);
    child.stdout?.on('data', (chunk: Buffer | string) => context.stdoutCapture.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => context.stderrCapture.append(chunk));
    if (child.pid !== undefined) await cgroup.assign(child.pid);

    await waitForApiSocket(dependencies, paths, config.apiTimeoutMs, child);
    await vmmIdentityManager.validateOwnedPaths([paths.apiSocketPath]);
    const client = dependencies.createClient(paths.apiSocketPath, config.apiTimeoutMs);
    context.setClient(client);
    await client.ping();
    if (child.pid === undefined) {
      throw new Error('Cloud Hypervisor launcher did not report a PID for confinement verification');
    }
    context.setConfinementEvidence(await dependencies.verifyConfinement({
      pid: child.pid,
      expectedExecutable: config.cloudHypervisorBinary,
      identity,
      launchPolicy: launchCommand.confinementPolicy,
      networkNamespace: networkPlan.namespaceName,
      cgroupPath: paths.cgroupPath,
      cgroupLimits: cgroup.expectedLimits(),
    }));
    if (guestConfig) {
      const virtiofsd = dependencies.createVirtiofsdManager(
        artifacts.virtiofsdBinary, paths.runDirectory, paths.virtiofsdShareDirectory,
        identity, cgroup, { mount: artifacts.tools.mount, umount: artifacts.tools.umount },
      );
      context.setVirtiofsd(virtiofsd);
      try {
        context.setFsDevices(
          await virtiofsd.start(guestConfig.exports, guestConfig.mountEnforcement),
        );
      } catch (error) {
        context.setFsDevices(virtiofsd.getDiagnosticDevices());
        throw error;
      }
      await vmmIdentityManager.validateOwnedPaths(
        context.getFsDevices().map((device) => device.socketPath),
      );
    }
    await client.vmCreate(buildCloudHypervisorVmConfig({
      config,
      paths,
      networkPlan,
      ...(guestConfig ? { guestConfig: { ...guestConfig, identity: guestIdentity } } : {}),
      fsDevices: context.getFsDevices(),
    }));
    if (guestConfig) {
      await vmmIdentityManager.validateOwnedPaths([paths.vsockSocketPath]);
    }
    return client;
  } catch (error) {
    startupError = error;
  }

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
    await context.stop();
  } catch (cleanupError) {
    throw new Error(
      `Cloud Hypervisor startup failed: ${formatError(startupError)}; ` +
      `partial-start cleanup also failed: ${formatError(cleanupError)}`,
    );
  }
  throw startupError;
}
