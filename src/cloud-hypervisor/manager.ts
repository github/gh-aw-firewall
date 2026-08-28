import { promises as fs } from 'fs';
import execa, { type ExecaChildProcess } from 'execa';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import {
  LinuxNetworkCommands,
  MicrovmNetworkManager,
  type MicrovmNetworkLifecycle,
  type MicrovmNetworkPlan,
} from '../microvm/network';
import {
  MicrovmVsockClient,
  type GuestExecutionRequest,
  type GuestExecutionResult,
} from '../microvm/vsock-client';
import {
  MicrovmRootfsPreparer,
} from '../microvm/rootfs';
import {
  CloudHypervisorApiClient,
  type CloudHypervisorVmCounters,
  type CloudHypervisorVmInfo,
} from './api-client';
import {
  BoundedOutputCapture,
  collectCloudHypervisorDiagnostics,
  readBoundedTail,
} from './diagnostics';
import {
  CloudHypervisorGuestChannel,
} from './guest-execution';
import {
  CloudHypervisorCgroup,
} from './launcher';
import {
  CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES,
  CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
  createCloudHypervisorRunPaths,
  type CloudHypervisorIdentity,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorManagerGuestConfig,
  type CloudHypervisorManagerNetworkConfig,
  type CloudHypervisorRunPaths,
} from './manager-types';
import { runCloudHypervisorPreflight } from './preflight';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { startCloudHypervisor } from './manager-start';
import { stopCloudHypervisor } from './manager-stop';
import { VirtiofsdManager, type VirtiofsdDevice } from './virtiofsd';

export {
  CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
  createCloudHypervisorRunPaths,
} from './manager-types';
export type {
  CloudHypervisorManagerDependencies,
  CloudHypervisorManagerGuestConfig,
  CloudHypervisorManagerNetworkConfig,
  CloudHypervisorRunPaths,
} from './manager-types';
export {
  buildSupervisorBootArgs,
  encodeVirtiofsBootArg,
} from './vm-config-builder';


const defaultDependencies: CloudHypervisorManagerDependencies = {
  preflight: runCloudHypervisorPreflight,
  launch: (command, args, options) => execa(command, args, options),
  mkdir: fs.mkdir,
  copyFile: fs.copyFile,
  chmod: fs.chmod,
  chown: fs.chown,
  writeFile: fs.writeFile,
  readFileTail: (filePath, maxBytes) => readBoundedTail(filePath, maxBytes),
  access: fs.access,
  rm: fs.rm,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  createClient: (socketPath, timeoutMs) => new CloudHypervisorApiClient({ socketPath, timeoutMs }),
  createNetwork: (plan, tools) => new MicrovmNetworkManager(
    plan,
    new LinuxNetworkCommands(undefined, tools),
  ),
  createRootfsPreparer: (config, tools) => new MicrovmRootfsPreparer(config, {
    runTool: async (command, args) => {
      const tool = tools[command as keyof CloudHypervisorHostToolPaths] ?? command;
      const result = await execa(tool, [...args], {
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      if (result.exitCode === 0 || (command === 'e2fsck' && result.exitCode === 1)) return;
      throw new Error(`${tool} exited with code ${result.exitCode}: ${result.stderr.trim()}`);
    },
  }),
  createVirtiofsdManager: (binaryPath, runDirectory, shareDirectory, identity, cgroup, tools) =>
    new VirtiofsdManager(binaryPath, runDirectory, shareDirectory, identity, cgroup, tools),
  createVsockClient: (socketPath, guestPort, timeoutMs) => new MicrovmVsockClient({
    socketPath,
    guestPort,
    connectTimeoutMs: timeoutMs,
    readTimeoutMs: Math.max(timeoutMs, 30_000),
    writeTimeoutMs: timeoutMs,
  }),
  createCgroup: (cgroupPath, limits) => new CloudHypervisorCgroup(cgroupPath, limits),
  resolveIdentity: resolveCloudHypervisorIdentity,
};

/** @internal Exposed only for focused host-adapter tests. */
export const cloudHypervisorManagerTestHelpers = {
  defaultDependencies,
  resolveCloudHypervisorIdentity,
};

function resolveCloudHypervisorIdentity(): CloudHypervisorIdentity {
  const operatorUid = parsePositiveIdentity(process.env.SUDO_UID) ?? process.getuid?.();
  const operatorGid = parsePositiveIdentity(process.env.SUDO_GID) ?? process.getgid?.();
  if (
    operatorUid === undefined ||
    operatorGid === undefined ||
    operatorUid === 0 ||
    operatorGid === 0
  ) {
    throw new Error(
      'Cloud Hypervisor requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  const uid = Number(getSafeHostUid());
  const gid = Number(getSafeHostGid());
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) {
    throw new Error(
      'Cloud Hypervisor requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  return { uid, gid };
}

function parsePositiveIdentity(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

/**
 * Owns one Cloud Hypervisor process launched via the secure host launcher in
 * `./launcher.ts` (network-namespace join + privilege drop + Landlock) and
 * its partial-start cleanup.
 *
 * This class is an orchestration facade: VM boot configuration lives in
 * `./vm-config-builder.ts`, run-directory staging plus failure diagnostics in
 * `./diagnostics.ts`, and the guest vsock execution surface in
 * `./guest-execution.ts`.
 */
export class CloudHypervisorManager {
  paths: CloudHypervisorRunPaths;
  private process: ExecaChildProcess<string> | undefined;
  private client: CloudHypervisorApiClient | undefined;
  private network: MicrovmNetworkLifecycle | undefined;
  private rootfsPreparer: MicrovmRootfsPreparer | undefined;
  private virtiofsd: VirtiofsdManager | undefined;
  private fsDevices: VirtiofsdDevice[] = [];
  private guest: CloudHypervisorGuestChannel | undefined;
  private cgroup: CloudHypervisorCgroup | undefined;
  private networkPlan: MicrovmNetworkPlan | undefined;
  private instanceStarted = false;
  // Snapshotted in stop(), before any shutdown attempt, since the API
  // socket becomes unresponsive once the process is asked to exit --
  // see the comment at the top of stop() for why this ordering matters.
  private lastVmInfo: CloudHypervisorVmInfo | undefined;
  private lastVmCounters: CloudHypervisorVmCounters | undefined;
  private readonly stdoutCapture = new BoundedOutputCapture(CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
  private readonly stderrCapture = new BoundedOutputCapture(CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);

  get guestIp(): string | undefined {
    return this.networkPlan?.guestIp;
  }

  get guestGatewayIp(): string | undefined {
    return this.networkPlan?.guestGatewayIp;
  }

  get guestPrefixLength(): number | undefined {
    return this.networkPlan?.guestPrefixLength;
  }

  get guestInterfaceName(): string | undefined {
    return this.networkPlan?.networkInterface.iface_id;
  }

  get networkNamespace(): string | undefined {
    return this.networkPlan?.namespaceName;
  }

  constructor(
    private readonly config: CloudHypervisorOptions,
    private readonly workDir: string,
    private readonly dependencies: CloudHypervisorManagerDependencies = defaultDependencies,
    runId?: string,
    private readonly networkConfig?: CloudHypervisorManagerNetworkConfig,
    private readonly guestConfig?: CloudHypervisorManagerGuestConfig,
  ) {
    this.paths = createCloudHypervisorRunPaths(config.cloudHypervisorBinary, runId);
  }

  async start(): Promise<CloudHypervisorApiClient> {
    return startCloudHypervisor({
      config: this.config,
      workDir: this.workDir,
      dependencies: this.dependencies,
      paths: this.paths,
      networkConfig: this.networkConfig,
      guestConfig: this.guestConfig,
      stdoutCapture: this.stdoutCapture,
      stderrCapture: this.stderrCapture,
      setNetworkPlan: (value) => { this.networkPlan = value; },
      setNetwork: (value) => { this.network = value; },
      setRootfsPreparer: (value) => { this.rootfsPreparer = value; },
      setCgroup: (value) => { this.cgroup = value; },
      setProcess: (value) => { this.process = value; },
      setClient: (value) => { this.client = value; },
      setVirtiofsd: (value) => { this.virtiofsd = value; },
      setFsDevices: (value) => { this.fsDevices = value; },
      getFsDevices: () => this.fsDevices,
      stop: () => this.stop(),
    });
  }

  async startInstance(): Promise<void> {
    if (!this.client) throw new Error('Cloud Hypervisor API is not configured');
    await this.client.vmBoot();
    this.instanceStarted = true;
    if (this.guestConfig) {
      this.guest = await CloudHypervisorGuestChannel.connect(
        this.dependencies,
        this.paths.vsockSocketPath,
        this.guestConfig.vsockPort ?? CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
        this.config.apiTimeoutMs,
      );
    }
  }

  async execute(
    request: GuestExecutionRequest,
  ): Promise<GuestExecutionResult> {
    if (!this.guest) {
      throw new Error('Cloud Hypervisor guest supervisor is not ready');
    }
    return this.guest.execute(request);
  }

  cancel(reason = 'host cancellation', requestId?: string): Promise<void> {
    if (!this.guest) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guest.cancel(reason, requestId);
  }

  writeStdin(data: Buffer, requestId?: string): Promise<void> {
    if (!this.guest) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guest.writeStdin(data, requestId);
  }

  endStdin(requestId?: string): Promise<void> {
    if (!this.guest) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guest.endStdin(requestId);
  }

  resize(columns: number, rows: number, requestId?: string): Promise<void> {
    if (!this.guest) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guest.resize(columns, rows, requestId);
  }

  async stop(options: { preserve?: boolean; beforeCleanup?: () => Promise<void> } = {}): Promise<void> {
    return stopCloudHypervisor({
      config: this.config,
      dependencies: this.dependencies,
      paths: this.paths,
      process: this.process,
      client: this.client,
      network: this.network,
      networkPlan: this.networkPlan,
      rootfsPreparer: this.rootfsPreparer,
      virtiofsd: this.virtiofsd,
      fsDevices: this.fsDevices,
      guest: this.guest,
      cgroup: this.cgroup,
      instanceStarted: this.instanceStarted,
      lastVmInfo: this.lastVmInfo,
      lastVmCounters: this.lastVmCounters,
      ...options,
      setProcess: (value) => { this.process = value; },
      setClient: (value) => { this.client = value; },
      setNetwork: (value) => { this.network = value; },
      setNetworkPlan: (value) => { this.networkPlan = value; },
      setRootfsPreparer: (value) => { this.rootfsPreparer = value; },
      setVirtiofsd: (value) => { this.virtiofsd = value; },
      setFsDevices: (value) => { this.fsDevices = value; },
      setGuest: (value) => { this.guest = value; },
      setCgroup: (value) => { this.cgroup = value; },
      setInstanceStarted: (value) => { this.instanceStarted = value; },
      setLastVmInfo: (value) => { this.lastVmInfo = value; },
      setLastVmCounters: (value) => { this.lastVmCounters = value; },
    });
  }

  async collectDiagnostics(directory: string): Promise<void> {
    await collectCloudHypervisorDiagnostics(directory, {
      dependencies: this.dependencies,
      paths: this.paths,
      config: this.config,
      stdoutCapture: this.stdoutCapture,
      stderrCapture: this.stderrCapture,
      network: this.network,
      networkPlan: this.networkPlan,
      client: this.client,
      instanceStarted: this.instanceStarted,
      lastVmInfo: this.lastVmInfo,
      lastVmCounters: this.lastVmCounters,
      fsDevices: this.fsDevices,
    });
  }
}
