import type { ExecaChildProcess } from 'execa';
import type { CloudHypervisorApiClient } from './api-client';
import { waitForApiSocket } from './diagnostics';
import {
  buildCloudHypervisorLaunchCommand,
  type CloudHypervisorCgroup,
} from './launcher';
import type {
  CloudHypervisorStartCheck,
  CloudHypervisorStartContext,
  CloudHypervisorStartResources,
} from './manager-start';
import type { CloudHypervisorStartNetwork } from './manager-start-network';
import { buildCloudHypervisorVmConfig } from './vm-config-builder';

export async function launchCloudHypervisorStart(
  context: CloudHypervisorStartContext,
  resources: CloudHypervisorStartResources,
  network: CloudHypervisorStartNetwork,
  cgroup: CloudHypervisorCgroup,
  check: CloudHypervisorStartCheck,
): Promise<CloudHypervisorApiClient> {
  const { config, dependencies, paths, workloadProfile } = context;
  const { artifacts, cleanupRecord, identity, guestIdentity, vmmIdentityManager } = resources;
  const { networkPlan, networkNamespace } = network;
  const guestConfig = workloadProfile.guest;
  return vmmIdentityManager.withDeviceAccess(async () => {
    const launchCommand = buildCloudHypervisorLaunchCommand({
      tools: { ip: artifacts.tools.ip, setpriv: artifacts.tools.setpriv },
      namespaceName: networkNamespace,
      identity,
      cloudHypervisorBinary: config.cloudHypervisorBinary,
      apiSocketPath: paths.apiSocketPath,
      logFilePath: paths.logPath,
    });
    await cleanupRecord.prepareProcess(
      'vmm', artifacts.cloudHypervisorBinary, paths.apiSocketPath,
    );
    const launch = () => dependencies.launch(launchCommand.command, [...launchCommand.args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Cloud Hypervisor directly processes untrusted guest/device input, so
      // its environment must not expose the host's provider credentials.
      extendEnv: false,
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    const registerLaunchedProcess = (): { child: ExecaChildProcess<string>; pid: number } => {
      const launched = launch();
      context.setProcess(launched);
      if (launched.pid === undefined) {
        throw new Error('Cloud Hypervisor process did not expose a PID');
      }
      return { child: launched, pid: launched.pid };
    };
    const launchedProcess = context.launchReport
      ? context.launchReport.checkSync('vmm-launch', registerLaunchedProcess)
      : registerLaunchedProcess();
    const { child, pid: processId } = launchedProcess;
    child.stdout?.on('data', (chunk: Buffer | string) => context.stdoutCapture.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => context.stderrCapture.append(chunk));
    await cgroup.assign(processId);
    await cleanupRecord.captureProcess('vmm', processId);

    await check('api-socket', () => waitForApiSocket(dependencies, paths, config.apiTimeoutMs, child));
    await vmmIdentityManager.validateOwnedPaths([paths.apiSocketPath]);
    const client = dependencies.createClient(paths.apiSocketPath, config.apiTimeoutMs);
    context.setClient(client);
    await check('api-ping', () => client.ping());
    if (child.pid === undefined) {
      throw new Error('Cloud Hypervisor launcher did not report a PID for confinement verification');
    }
    const pid = child.pid;
    context.setConfinementEvidence(await check('confinement', () => dependencies.verifyConfinement({
      pid,
      expectedExecutable: config.cloudHypervisorBinary,
      identity,
      launchPolicy: launchCommand.confinementPolicy,
      networkNamespace,
      cgroupPath: paths.cgroupPath,
      cgroupLimits: cgroup.expectedLimits(),
    })));
    if (guestConfig) {
      const virtiofsd = dependencies.createVirtiofsdManager(
        artifacts.virtiofsdBinary, paths.runDirectory, paths.virtiofsdShareDirectory,
        identity, guestIdentity, cgroup,
        { mount: artifacts.tools.mount, umount: artifacts.tools.umount },
        cleanupRecord,
      );
      context.setVirtiofsd(virtiofsd);
      try {
        context.setFsDevices(
          await check('virtiofsd', () => virtiofsd.start(
            guestConfig.exports,
            guestConfig.mountEnforcement,
            guestConfig.enclaveResources?.writableStorageBytes,
          )),
        );
        await cleanupRecord.captureVirtiofsdResources();
      } catch (error) {
        context.setFsDevices(virtiofsd.getDiagnosticDevices());
        throw error;
      }
      await vmmIdentityManager.validateOwnedPaths(
        context.getFsDevices().map((device) => device.socketPath),
      );
    }
    await check('vm-create', () => client.vmCreate(buildCloudHypervisorVmConfig({
      config,
      paths,
      networkPlan,
      ...(guestConfig ? { guestConfig: { ...guestConfig, identity: guestIdentity } } : {}),
      ...(guestConfig?.enclaveResources
        ? { enclaveResources: guestConfig.enclaveResources }
        : {}),
      fsDevices: context.getFsDevices(),
    })));
    return client;
  }, networkPlan !== undefined);
}
