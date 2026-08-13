import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import {
  CLOUD_HYPERVISOR_RELEASE_VERSION,
  type CloudHypervisorOptions,
} from '../types/runtime-options';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import {
  LinuxNetworkCommands,
  MicrovmNetworkManager,
  assertSafeMicrovmRunId,
  createMicrovmNetworkPlan,
  type MicrovmControlPeer,
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
  type MicrovmRootfsConfig,
} from '../microvm/rootfs';
import {
  CloudHypervisorApiClient,
  type CloudHypervisorVmCounters,
  type CloudHypervisorVmInfo,
} from './api-client';
import {
  CLOUD_HYPERVISOR_GUEST_CID,
  CloudHypervisorCgroup,
  buildCloudHypervisorLaunchCommand,
  computeCloudHypervisorLandlockRules,
  type CloudHypervisorResourceLimits,
} from './launcher';
import { runCloudHypervisorPreflight } from './preflight';
import type { CloudHypervisorHostToolPaths } from './preflight';
import {
  validateCloudHypervisorExports,
  type CloudHypervisorDirectoryExport,
} from './exports';
import { VirtiofsdManager, type VirtiofsdDevice } from './virtiofsd';

const API_SOCKET_NAME = 'api.socket';
const VSOCK_SOCKET_NAME = 'awf-vsock.socket';
const KERNEL_RUN_NAME = 'kernel';
const ROOTFS_RUN_NAME = 'rootfs.ext4';
const CLOUD_HYPERVISOR_LOG_NAME = 'cloud-hypervisor.log';
const CLOUD_HYPERVISOR_SERIAL_LOG_NAME = 'serial.log';
const CLOUD_HYPERVISOR_GUEST_SUPERVISOR = '/usr/sbin/awf-supervisor';
const CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES = 1024 * 1024;
export const CLOUD_HYPERVISOR_GUEST_VSOCK_PORT = 52;
const CLOUD_HYPERVISOR_GUEST_SHUTDOWN_GRACE_MS = 5_000;
/**
 * Cloud Hypervisor's vsock-over-UDS multiplexer closes the host-facing
 * connection immediately (rather than blocking/retrying) if the guest
 * isn't yet listening on the target vsock port when a `CONNECT <port>`
 * handshake arrives — observed live as `startInstance()` failing with
 * "guest disconnected before readiness" even on a successful `vm.boot()`.
 * This is a real host/guest boot-timing race (kernel decompression +
 * supervisor startup take a variable, host-load-dependent amount of time),
 * not a fatal error, so the connect is retried with a fresh client and a
 * short backoff until the guest is actually ready or this budget elapses.
 *
 * The budget is deliberately generous (not a tight few-second timeout):
 * live validation on GitHub-hosted Ubuntu runners showed the guest kernel's
 * own internal clock advancing far slower than host wall-clock time during
 * early PCI/virtio device enumeration (e.g. ~9-20s of host wall-clock time
 * elapsing while the guest's own boot log timestamps were still under 1s)
 * — consistent with the extra scheduling overhead of nested virtualization
 * on these runners (Cloud Hypervisor itself logs running under a
 * "Microsoft Hv" nested hypervisor there). A short budget here would abort
 * a guest that is simply slow to be scheduled, not actually hung or
 * crashed. This matches the smoke test's own boot-readiness ceiling
 * (`BOOT_READINESS_CEILING_MS` in cloud-hypervisor-live-smoke.sh).
 */
const CLOUD_HYPERVISOR_GUEST_READY_RETRY_INTERVAL_MS = 250;
const CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS = 90_000;
/**
 * Private run-directory root, deliberately **outside** `workDir`.
 *
 * `workDir` is created root-owned mode 0700 (it holds `docker-compose.yml`
 * with plaintext secrets — see `validateAndPrepareWorkDir` in
 * `src/config-writer.ts`), so a non-root process can never traverse into
 * it no matter how a leaf directory underneath it is chowned. Since this
 * backend has no jailer to `chroot()` the launched process (which would
 * make host-side ancestor permissions irrelevant), Cloud Hypervisor must
 * be able to really `stat()`/`open()` its way down to the run directory
 * post-`setpriv`. `/run` is always present, root-owned tmpfs; the two
 * ancestor levels created under it are `0711` (traversable/executable by
 * any uid, but not listable/readable — `ls` still fails), and only the
 * per-run leaf directory is chowned to the non-root target identity with
 * `0700` (so only that identity, or root, can actually read its contents).
 */
const CLOUD_HYPERVISOR_RUN_ROOT = '/run/awf-cloud-hypervisor';
const CGROUP_ROOT = '/sys/fs/cgroup';

export interface CloudHypervisorRunPaths {
  runId: string;
  runBaseDir: string;
  runDirectory: string;
  apiSocketPath: string;
  kernelPath: string;
  rootfsPath: string;
  vsockSocketPath: string;
  logPath: string;
  serialLogPath: string;
  virtiofsdShareDirectory: string;
  cgroupPath: string;
}

export interface CloudHypervisorManagerDependencies {
  preflight: typeof runCloudHypervisorPreflight;
  launch(
    command: string,
    args: string[],
    options: {
      reject: false;
      stdio: ['ignore', 'pipe', 'pipe'];
      env: NodeJS.ProcessEnv;
      extendEnv: false;
    },
  ): ExecaChildProcess<string>;
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  copyFile(source: string, destination: string, flags: number): Promise<void>;
  chmod(filePath: string, mode: number): Promise<void>;
  chown(filePath: string, uid: number, gid: number): Promise<void>;
  writeFile: typeof fs.writeFile;
  readFileTail(filePath: string, maxBytes: number): Promise<Buffer>;
  access(filePath: string): Promise<void>;
  rm(directory: string, options: { recursive: true; force: true }): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  createClient(socketPath: string, timeoutMs: number): CloudHypervisorApiClient;
  createNetwork(plan: MicrovmNetworkPlan, tools: CloudHypervisorHostToolPaths): MicrovmNetworkLifecycle;
  createRootfsPreparer(config: MicrovmRootfsConfig, tools: CloudHypervisorHostToolPaths): MicrovmRootfsPreparer;
  createVirtiofsdManager(
    binaryPath: string,
    runDirectory: string,
    shareDirectory: string,
    identity: { uid: number; gid: number },
    cgroup: CloudHypervisorCgroup,
    tools: Pick<CloudHypervisorHostToolPaths, 'mount' | 'umount'>,
  ): VirtiofsdManager;
  createVsockClient(socketPath: string, guestPort: number, timeoutMs: number): MicrovmVsockClient;
  createCgroup(cgroupPath: string, limits: CloudHypervisorResourceLimits): CloudHypervisorCgroup;
  resolveIdentity(): { uid: number; gid: number };
}

export interface CloudHypervisorManagerNetworkConfig {
  infrastructureBridge: string;
  enableApiProxy: boolean;
  apiProxyIp?: string;
  controlPeer?: MicrovmControlPeer;
  controlPeers?: readonly MicrovmControlPeer[];
  hostAliases?: Readonly<Record<string, string>>;
}

export interface CloudHypervisorManagerGuestConfig {
  readonly exports: readonly CloudHypervisorDirectoryExport[];
  readonly supervisorBinaryPath: string;
  readonly supervisorSha256: string;
  readonly vsockPort?: number;
  readonly identity?: { uid: number; gid: number };
}

async function readBoundedTail(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(buffer, 0, length, size - length);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

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

function resolveCloudHypervisorIdentity(): { uid: number; gid: number } {
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

export function createCloudHypervisorRunPaths(
  cloudHypervisorBinary: string,
  runId = `awf-${process.pid}-${randomBytes(6).toString('hex')}`,
): CloudHypervisorRunPaths {
  assertSafeMicrovmRunId(runId);
  const runBaseDir = CLOUD_HYPERVISOR_RUN_ROOT;
  const runDirectory = path.join(
    runBaseDir,
    path.basename(cloudHypervisorBinary),
    runId,
  );
  return {
    runId,
    runBaseDir,
    runDirectory,
    apiSocketPath: path.join(runDirectory, API_SOCKET_NAME),
    kernelPath: path.join(runDirectory, KERNEL_RUN_NAME),
    rootfsPath: path.join(runDirectory, ROOTFS_RUN_NAME),
    vsockSocketPath: path.join(runDirectory, VSOCK_SOCKET_NAME),
    logPath: path.join(runDirectory, CLOUD_HYPERVISOR_LOG_NAME),
    serialLogPath: path.join(runDirectory, CLOUD_HYPERVISOR_SERIAL_LOG_NAME),
    virtiofsdShareDirectory: path.join(runBaseDir, 'virtiofsd', runId),
    cgroupPath: path.join(CGROUP_ROOT, 'awf-cloud-hypervisor', runId),
  };
}

/**
 * Owns one Cloud Hypervisor process launched via the secure host launcher in
 * `./launcher.ts` (network-namespace join + privilege drop + Landlock, in
 * place of Firecracker's jailer) and its partial-start cleanup.
 */
export class CloudHypervisorManager {
  paths: CloudHypervisorRunPaths;
  private process: ExecaChildProcess<string> | undefined;
  private client: CloudHypervisorApiClient | undefined;
  private network: MicrovmNetworkLifecycle | undefined;
  private rootfsPreparer: MicrovmRootfsPreparer | undefined;
  private virtiofsd: VirtiofsdManager | undefined;
  private fsDevices: VirtiofsdDevice[] = [];
  private guestClient: MicrovmVsockClient | undefined;
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
    if (!this.networkConfig) {
      throw new Error(
        'Cloud Hypervisor network configuration is required; refusing to launch an unfiltered microVM',
      );
    }

    let startupError: unknown;
    try {
      const artifacts = await this.dependencies.preflight(this.config);
      const identity = this.guestConfig?.identity ?? this.dependencies.resolveIdentity();
      const networkPlan = createMicrovmNetworkPlan(this.paths.runId, {
        ...this.networkConfig,
        tapOwnerUid: identity.uid,
        tapOwnerGid: identity.gid,
        // Cloud Hypervisor's own tap handling (Tap::open_named() in
        // net_util/src/tap.rs) always re-opens the tap with
        // IFF_VNET_HDR requested; the tap must be *created* with that
        // feature available or the host and Cloud Hypervisor disagree
        // on frame layout for the host-to-guest direction, and guest
        // connectivity checks silently time out even though the
        // guest's own outbound traffic (and the host-side veth/nft
        // layer) works normally. Discovered via live-KVM validation:
        // tap RX=10 packets (guest-to-host, unaffected) vs. TX=1 packet
        // (host-to-guest, effectively stalled) despite response
        // packets already having arrived on the host-side veth.
        // Firecracker's own tap handling does not request
        // IFF_VNET_HDR, so this is opted in here only, not changed for
        // the shared default.
        tapVnetHdr: true,
      });
      this.networkPlan = networkPlan;
      this.network = this.dependencies.createNetwork(networkPlan, artifacts.tools);
      await this.network.setup();
      let rootfsSource = artifacts.rootfsPath;
      if (this.guestConfig) {
        validateCloudHypervisorExports(this.guestConfig.exports);
        const rootfsPreparationDirectory = path.join(
          this.workDir,
          'cloud-hypervisor-rootfs',
          this.paths.runId,
        );
        this.rootfsPreparer = this.dependencies.createRootfsPreparer({
          runDirectory: rootfsPreparationDirectory,
          baseRootfsPath: artifacts.rootfsPath,
          supervisorBinaryPath: this.guestConfig.supervisorBinaryPath,
          supervisorSha256: this.guestConfig.supervisorSha256,
          supervisorGuestPath: CLOUD_HYPERVISOR_GUEST_SUPERVISOR,
          hostAliases: {
            ...(this.networkConfig.apiProxyIp
              ? { 'api-proxy': this.networkConfig.apiProxyIp }
              : {}),
            ...(this.networkConfig.hostAliases ?? {}),
          },
        }, artifacts.tools);
        rootfsSource = await this.rootfsPreparer.prepare();
      }

      await this.prepareRunDirectory(identity);

      this.cgroup = this.dependencies.createCgroup(
        this.paths.cgroupPath,
        { memoryMib: this.config.memoryMib, vcpuCount: this.config.vcpuCount },
      );
      await this.cgroup.setup();

      await this.stageArtifact(artifacts.kernelPath, this.paths.kernelPath, 0o400, identity);
      await this.stageArtifact(rootfsSource, this.paths.rootfsPath, 0o600, identity);
      await this.stageDiagnosticFile(this.paths.logPath, identity);
      await this.stageDiagnosticFile(this.paths.serialLogPath, identity);

      const launchCommand = buildCloudHypervisorLaunchCommand({
        tools: { ip: artifacts.tools.ip, setpriv: artifacts.tools.setpriv },
        namespaceName: networkPlan.namespaceName,
        identity,
        kvmGid: artifacts.kvmGid,
        cloudHypervisorBinary: this.config.cloudHypervisorBinary,
        apiSocketPath: this.paths.apiSocketPath,
        logFilePath: this.paths.logPath,
      });
      this.process = this.dependencies.launch(
        launchCommand.command,
        [...launchCommand.args],
        {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Explicit minimal environment: the launched process must never
          // inherit AWF's host environment (provider/GitHub credentials
          // the guest environment deliberately excludes). Cloud Hypervisor
          // directly processes untrusted guest/device input, so a VMM
          // compromise reading `process.env` would bypass the API-proxy
          // credential isolation boundary entirely. `extendEnv: false`
          // stops execa from merging this back with `process.env`.
          extendEnv: false,
          env: buildLauncherEnvironment(),
        },
      );
      this.process.stdout?.on('data', (chunk: Buffer | string) => {
        this.stdoutCapture.append(chunk);
      });
      this.process.stderr?.on('data', (chunk: Buffer | string) => {
        this.stderrCapture.append(chunk);
      });
      if (this.process.pid !== undefined) {
        await this.cgroup.assign(this.process.pid);
      }

      await this.waitForApiSocket();
      this.client = this.dependencies.createClient(
        this.paths.apiSocketPath,
        this.config.apiTimeoutMs,
      );
      await this.client.ping();
      if (this.guestConfig) {
        this.virtiofsd = this.dependencies.createVirtiofsdManager(
          artifacts.virtiofsdBinary,
          this.paths.runDirectory,
          this.paths.virtiofsdShareDirectory,
          identity,
          this.cgroup,
          { mount: artifacts.tools.mount, umount: artifacts.tools.umount },
        );
        this.fsDevices = await this.virtiofsd.start(this.guestConfig.exports);
      }
      await this.client.vmCreate(this.buildVmConfig(networkPlan));
      return this.client;
    } catch (error) {
      startupError = error;
    }

    try {
      await this.stop();
    } catch (cleanupError) {
      throw new Error(
        `Cloud Hypervisor startup failed: ${formatError(startupError)}; ` +
        `partial-start cleanup also failed: ${formatError(cleanupError)}`,
      );
    }
    throw startupError;
  }

  private buildVmConfig(networkPlan: MicrovmNetworkPlan) {
    const landlockRules = computeCloudHypervisorLandlockRules({
      kernelPath: this.paths.kernelPath,
      rootfsPath: this.paths.rootfsPath,
      runDirectory: this.paths.runDirectory,
      apiSocketPath: this.paths.apiSocketPath,
      vsockSocketPath: this.paths.vsockSocketPath,
      tapName: networkPlan.tapName,
    });
    return {
      cpus: {
        boot_vcpus: this.config.vcpuCount,
        max_vcpus: this.config.vcpuCount,
      },
      memory: {
        size: this.config.memoryMib * 1024 * 1024,
        ...(this.fsDevices.length > 0 ? { shared: true } : {}),
      },
      payload: {
        kernel: this.paths.kernelPath,
        ...(this.guestConfig
          ? { cmdline: buildSupervisorBootArgs(networkPlan, this.guestConfig) }
          : {}),
      },
      disks: [
        {
          id: 'rootfs',
          path: this.paths.rootfsPath,
          readonly: false,
          image_type: 'Raw' as const,
        },
      ],
      ...(this.fsDevices.length > 0
        ? {
            fs: this.fsDevices.map((device) => ({
              tag: device.export.tag,
              socket: device.socketPath,
              num_queues: 1,
              queue_size: 1024,
            })),
          }
        : {}),
      net: [{
        id: 'net0',
        tap: networkPlan.networkInterface.host_dev_name,
        mac: networkPlan.networkInterface.guest_mac ?? '',
        // Cloud Hypervisor defaults all three offloads to enabled. This
        // entire network path is a fully-software bridge/veth/tap chain
        // with no real NIC downstream to finish partially-offloaded
        // (unchecksummed / not-yet-segmented) frames; live-KVM validation
        // showed guest-to-Squid traffic being forwarded (visible in nft
        // counters) but the return path never matching the
        // established/related accept rule, with zero visibility into
        // whether nftables' conntrack was marking replies as invalid.
        // Disable all three explicitly rather than rely on Cloud
        // Hypervisor's own defaults, removing offload-related packet
        // malformation as a possible cause.
        offload_tso: false,
        offload_ufo: false,
        offload_csum: false,
      }],
      rng: { src: '/dev/urandom' },
      serial: { mode: 'File' as const, file: this.paths.serialLogPath },
      console: { mode: 'Off' as const },
      ...(this.guestConfig
        ? { vsock: { cid: CLOUD_HYPERVISOR_GUEST_CID, socket: this.paths.vsockSocketPath } }
        : {}),
      watchdog: false,
      landlock_enable: true,
      landlock_rules: landlockRules,
    };
  }

  async startInstance(): Promise<void> {
    if (!this.client) throw new Error('Cloud Hypervisor API is not configured');
    await this.client.vmBoot();
    this.instanceStarted = true;
    if (this.guestConfig) {
      this.guestClient = await this.connectGuestWithRetry(
        this.guestConfig.vsockPort ?? CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
      );
    }
  }

  /**
   * Connects to the guest supervisor over vsock, retrying on the
   * "guest disconnected before readiness" boot-timing race documented on
   * {@link CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS} above. Each attempt
   * uses a fresh client (MicrovmVsockClient does not support reconnecting
   * a socket that already closed).
   */
  private async connectGuestWithRetry(port: number): Promise<MicrovmVsockClient> {
    const deadline = Date.now() + CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS;
    let lastError: unknown;
    do {
      const client = this.dependencies.createVsockClient(
        this.paths.vsockSocketPath,
        port,
        this.config.apiTimeoutMs,
      );
      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        client.destroy();
        if (Date.now() >= deadline) break;
        await this.dependencies.sleep(CLOUD_HYPERVISOR_GUEST_READY_RETRY_INTERVAL_MS);
      }
    } while (Date.now() < deadline);
    throw lastError instanceof Error
      ? lastError
      : new Error('Cloud Hypervisor guest vsock connection failed');
  }

  async execute(
    request: GuestExecutionRequest,
  ): Promise<GuestExecutionResult> {
    if (!this.guestClient) {
      throw new Error('Cloud Hypervisor guest supervisor is not ready');
    }
    return this.guestClient.execute(request);
  }

  cancel(reason = 'host cancellation', requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guestClient.cancel(reason, requestId);
  }

  writeStdin(data: Buffer, requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guestClient.writeStdin(data, requestId);
  }

  endStdin(requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guestClient.endStdin(requestId);
  }

  resize(columns: number, rows: number, requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Cloud Hypervisor guest supervisor is not ready'));
    }
    return this.guestClient.resize(columns, rows, requestId);
  }

  async stop(options: { preserve?: boolean; beforeCleanup?: () => Promise<void> } = {}): Promise<void> {
    const errors: unknown[] = [];
    const instanceWasStarted = this.instanceStarted;
    // vm.info/vm.counters require the Cloud Hypervisor API socket to
    // still be responsive, which is only true *before* vmm.shutdown()/
    // process termination below -- the opposite ordering constraint from
    // serial console capture (which needs the process already exited to
    // guarantee flushed output; see the beforeCleanup comment further
    // down). Snapshot both here, before any shutdown attempt, so
    // collectDiagnostics() (invoked later, via beforeCleanup, after the
    // process has already exited) has a real, non-null snapshot to write
    // instead of failing silently against an already-closed socket.
    if (this.client && instanceWasStarted) {
      try {
        this.lastVmInfo = await this.client.vmInfo();
      } catch {
        this.lastVmInfo = undefined;
      }
      try {
        this.lastVmCounters = await this.client.vmCounters();
      } catch {
        this.lastVmCounters = undefined;
      }
    }
    let guestShutdownAcknowledged = false;
    if (this.guestClient) {
      try {
        await this.guestClient.shutdown();
        guestShutdownAcknowledged = true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'Cannot shut down guest while a request is running'
        ) {
          errors.push(error);
        }
        this.guestClient.destroy();
      }
    }
    this.guestClient = undefined;

    if (this.client && instanceWasStarted && guestShutdownAcknowledged) {
      try {
        await this.client.vmShutdown();
      } catch {
        // The process-level termination below remains authoritative; a
        // failed graceful vm.shutdown just means we fall through to SIGTERM.
      }
    }
    if (this.client) {
      try {
        await this.client.vmmShutdown();
      } catch {
        // Same as above: SIGTERM/SIGKILL below is authoritative.
      }
    }

    let terminationConfirmed = !this.process ||
      this.process.exitCode !== null ||
      this.process.signalCode !== null;
    if (
      this.process &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    ) {
      const child = this.process;
      try {
        terminationConfirmed = await this.waitForProcessExit(
          child,
          CLOUD_HYPERVISOR_GUEST_SHUTDOWN_GRACE_MS,
        );
        if (!child.killed) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM', { forceKillAfterTimeout: 2_000 });
          }
        }
        if (!terminationConfirmed) {
          await child;
          if (child.exitCode === null && child.signalCode === null) {
            throw new Error('Cloud Hypervisor process termination was not confirmed');
          }
        }
        terminationConfirmed = true;
      } catch (error) {
        terminationConfirmed = child.exitCode !== null || child.signalCode !== null;
        errors.push(error);
      }
    }
    if (!terminationConfirmed && this.process) {
      if (errors.length === 0) {
        errors.push(new Error('Cloud Hypervisor process termination was not confirmed'));
      }
      try {
        await this.virtiofsd?.stop();
        this.virtiofsd = undefined;
        this.fsDevices = [];
      } catch (error) {
        errors.push(error);
      }
      throw new Error(
        `Cloud Hypervisor cleanup stopped before network/run-directory removal: ` +
        `${errors.map(formatError).join('; ')}`,
      );
    }
    this.process = undefined;
    this.client = undefined;

    let virtiofsdTerminationConfirmed = true;
    try {
      await this.virtiofsd?.stop();
      this.virtiofsd = undefined;
    } catch (error) {
      virtiofsdTerminationConfirmed = false;
      errors.push(error);
    }

    // Run any caller-supplied diagnostics collection now: the Cloud
    // Hypervisor process is confirmed terminated (so any buffered guest
    // serial console / log output has been flushed by process exit), but
    // the run directory containing those files has not been removed yet
    // (that happens below). Collecting diagnostics any earlier (e.g.
    // before vmm.shutdown()/process termination above) can observe a
    // still-empty serial console log, since Cloud Hypervisor does not
    // guarantee flushing it before the process actually exits.
    if (options.beforeCleanup) {
      try {
        await options.beforeCleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (!virtiofsdTerminationConfirmed) {
      throw new Error(
        `Cloud Hypervisor cleanup stopped before cgroup/run-directory removal: ` +
        `${errors.map(formatError).join('; ')}`,
      );
    }
    this.fsDevices = [];

    this.instanceStarted = false;

    if (this.rootfsPreparer) {
      try {
        await this.dependencies.rm(
          path.dirname(this.rootfsPreparer.rootfsImagePath),
          { recursive: true, force: true },
        );
      } catch (error) {
        errors.push(error);
      }
    }
    this.rootfsPreparer = undefined;

    if (options.preserve) {
      try {
        await this.cgroup?.cleanup();
      } catch (error) {
        errors.push(error);
      }
      this.cgroup = undefined;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new Error(
          `Cloud Hypervisor preservation failed: ${errors.map(formatError).join('; ')}`,
        );
      }
      return;
    }

    try {
      await this.network?.cleanup();
      this.network = undefined;
      this.networkPlan = undefined;
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.cgroup?.cleanup();
    } catch (error) {
      errors.push(error);
    }
    this.cgroup = undefined;

    if (!instanceWasStarted || terminationConfirmed) {
      try {
        await this.dependencies.rm(
          path.join(
            this.paths.runBaseDir,
            path.basename(this.config.cloudHypervisorBinary),
            this.paths.runId,
          ),
          { recursive: true, force: true },
        );
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new Error(
        `Cloud Hypervisor cleanup failed: ${errors.map(formatError).join('; ')}`,
      );
    }
  }

  private async waitForProcessExit(
    child: ExecaChildProcess<string>,
    timeoutMs: number,
  ): Promise<boolean> {
    const pollIntervalMs = 25;
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      await this.dependencies.sleep(pollIntervalMs);
    }
    return child.exitCode !== null || child.signalCode !== null;
  }

  async collectDiagnostics(directory: string): Promise<void> {
    await this.dependencies.mkdir(directory, { recursive: true, mode: 0o700 });
    // Prefer the snapshot stop() takes *before* any shutdown attempt (see
    // the comment at the top of stop()): by the time collectDiagnostics()
    // runs via the beforeCleanup hook, the API socket is already
    // unresponsive (process already asked to exit), so a live call here
    // would just fail. Fall back to a live call only when this method is
    // invoked directly, outside of stop() (e.g. --diagnostic-logs without
    // a failure, or this method's own unit tests), where the client may
    // still be genuinely reachable.
    let counters: unknown = this.lastVmCounters ?? null;
    if (counters === null && this.client && this.instanceStarted) {
      try {
        counters = await this.client.vmCounters();
      } catch {
        counters = null;
      }
    }
    let vmInfo: unknown = this.lastVmInfo ?? null;
    if (vmInfo === null && this.client && this.instanceStarted) {
      try {
        vmInfo = await this.client.vmInfo();
      } catch {
        vmInfo = null;
      }
    }
    const writeBounded = async (fileName: string, contents: Buffer): Promise<void> => {
      const destination = path.join(directory, fileName);
      await this.dependencies.writeFile(destination, contents, { mode: 0o600 });
    };
    await writeBounded('launcher-stdout.log', this.stdoutCapture.contents());
    await writeBounded('launcher-stderr.log', this.stderrCapture.contents());
    await this.copyBoundedDiagnostic(
      this.paths.logPath,
      path.join(directory, CLOUD_HYPERVISOR_LOG_NAME),
    );
    await this.copyBoundedDiagnostic(
      this.paths.serialLogPath,
      path.join(directory, CLOUD_HYPERVISOR_SERIAL_LOG_NAME),
    );
    for (const [index, device] of this.fsDevices.entries()) {
      await this.copyBoundedDiagnostic(
        device.logPath,
        path.join(directory, `virtiofs-${index}-${device.export.tag}.log`),
      );
    }
    await this.dependencies.writeFile(
      path.join(directory, 'network-plan.json'),
      `${JSON.stringify(this.networkPlan ?? null, null, 2)}\n`,
      { mode: 0o600 },
    );
    // Best-effort, read-only host-side network diagnostics (live nftables
    // ruleset + interface counters), captured only while the namespace
    // still exists (this method runs via stop()'s beforeCleanup hook,
    // before network.cleanup() tears the namespace down). Helps diagnose
    // a guest connectivity failure (dropped by a forward-chain rule vs.
    // never reaching the tap at all) without guessing from the guest
    // side alone.
    let networkDiagnostics = '(network namespace not set up)';
    if (this.network?.captureDiagnostics) {
      try {
        networkDiagnostics = await this.network.captureDiagnostics();
      } catch (error) {
        networkDiagnostics = `(capture failed: ${formatError(error)})`;
      }
    }
    await this.dependencies.writeFile(
      path.join(directory, 'network-diagnostics.txt'),
      `${networkDiagnostics}\n`,
      { mode: 0o600 },
    );
    await this.dependencies.writeFile(
      path.join(directory, 'counters.json'),
      `${JSON.stringify(counters, null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.dependencies.writeFile(
      path.join(directory, 'vm-info.json'),
      `${JSON.stringify(vmInfo, null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.dependencies.writeFile(
      path.join(directory, 'runtime.json'),
      `${JSON.stringify({
        runtime: 'cloud-hypervisor',
        version: CLOUD_HYPERVISOR_RELEASE_VERSION,
        runId: this.paths.runId,
        vcpuCount: this.config.vcpuCount,
        memoryMib: this.config.memoryMib,
        instanceStarted: this.instanceStarted,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async waitForApiSocket(): Promise<void> {
    const deadline = Date.now() + this.config.apiTimeoutMs;
    while (Date.now() < deadline) {
      if (this.process && (this.process.exitCode != null || this.process.signalCode != null)) {
        throw new Error(
          `Cloud Hypervisor exited before API readiness with code ${this.process.exitCode ?? 'null'} ` +
          `and signal ${this.process.signalCode ?? 'null'}`,
        );
      }
      try {
        await this.dependencies.access(this.paths.apiSocketPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
      await this.dependencies.sleep(25);
    }
    throw new Error(
      `Cloud Hypervisor API socket was not ready after ${this.config.apiTimeoutMs}ms: ` +
      this.paths.apiSocketPath,
    );
  }

  /**
   * Creates the private run-directory chain with real traversal
   * permissions for the non-root target identity: the two ancestor
   * levels (`CLOUD_HYPERVISOR_RUN_ROOT` and the per-binary directory
   * beneath it) are `0711` root-owned (executable/traversable by any uid,
   * but not listable), and only the per-run leaf directory is chowned to
   * the target identity with `0700` (so only that identity, or root, can
   * actually read its contents). See the `CLOUD_HYPERVISOR_RUN_ROOT`
   * comment above for why this can't simply live under `workDir`.
   */
  private async prepareRunDirectory(identity: { uid: number; gid: number }): Promise<void> {
    const binaryDir = path.dirname(this.paths.runDirectory);
    await this.dependencies.mkdir(this.paths.runBaseDir, { recursive: true, mode: 0o711 });
    await this.dependencies.chmod(this.paths.runBaseDir, 0o711);
    await this.dependencies.mkdir(binaryDir, { recursive: true, mode: 0o711 });
    await this.dependencies.chmod(binaryDir, 0o711);
    await this.dependencies.mkdir(this.paths.runDirectory, { recursive: true, mode: 0o700 });
    await this.dependencies.chown(this.paths.runDirectory, identity.uid, identity.gid);
  }

  private async stageArtifact(
    source: string,
    destination: string,
    mode: number,
    identity: { uid: number; gid: number },
  ): Promise<void> {
    await this.dependencies.copyFile(source, destination, constants.COPYFILE_EXCL);
    await this.dependencies.chown(destination, identity.uid, identity.gid);
    await this.dependencies.chmod(destination, mode);
  }

  private async stageDiagnosticFile(
    destination: string,
    identity: { uid: number; gid: number },
  ): Promise<void> {
    await this.dependencies.writeFile(destination, '', { flag: 'wx', mode: 0o600 });
    await this.dependencies.chown(destination, identity.uid, identity.gid);
  }

  private async copyBoundedDiagnostic(source: string, destination: string): Promise<void> {
    try {
      const bounded = await this.dependencies.readFileTail(source, CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
      await this.dependencies.writeFile(destination, bounded, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function buildSupervisorBootArgs(
  networkPlan: MicrovmNetworkPlan,
  guestConfig: CloudHypervisorManagerGuestConfig,
): string {
  const port = guestConfig.vsockPort ?? CLOUD_HYPERVISOR_GUEST_VSOCK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Cloud Hypervisor guest vsock port must be in 1-65535: ${port}`);
  }
  return [
    'console=ttyS0',
    'reboot=k',
    // Do not reboot-loop over the terminal panic: Cloud Hypervisor recreates
    // the serial file on reset, which otherwise erases the actionable error.
    'panic=0',
    'root=/dev/vda',
    'rootfstype=ext4',
    'rootflags=data=ordered',
    'rw',
    // Cloud Hypervisor requires PCI (no `pci=off` MMIO-only mode like
    // Firecracker); pin legacy `ethN` interface naming so the guest's
    // single virtio-pci NIC has a deterministic name across boots.
    'net.ifnames=0',
    'biosdevname=0',
    `init=${CLOUD_HYPERVISOR_GUEST_SUPERVISOR}`,
    'awf.workspace-mount=/workspace',
    `awf.virtiofs=${encodeVirtiofsBootArg(guestConfig.exports)}`,
    `awf.vsock-port=${port}`,
    `awf.guest-ip=${networkPlan.guestIp}`,
    `awf.guest-prefix=${networkPlan.guestPrefixLength}`,
    `awf.guest-gateway=${networkPlan.guestGatewayIp}`,
    'awf.guest-interface=eth0',
  ].join(' ');
}

export function encodeVirtiofsBootArg(
  exports: readonly CloudHypervisorDirectoryExport[],
): string {
  const encoded = validateCloudHypervisorExports(exports)
    .map((entry) => (
      `${entry.tag}:${Buffer.from(entry.target).toString('base64url')}:${entry.mode}`
    ))
    .join(';');
  if (Buffer.byteLength(encoded) > 4096) {
    throw new Error('Cloud Hypervisor virtio-fs boot argument exceeds 4096 bytes');
  }
  return encoded;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Explicit, minimal environment for the launched `ip netns exec ... setpriv
 * ... cloud-hypervisor` process. Deliberately does **not** include
 * `process.env` — Cloud Hypervisor directly parses untrusted guest/device
 * input, so a VMM compromise reading its own inherited environment could
 * read provider/GitHub credentials and bypass the API-proxy credential
 * isolation boundary. Callers must also pass `extendEnv: false` to execa;
 * otherwise execa merges this object back into `process.env`.
 */
function buildLauncherEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
}

class BoundedOutputCapture {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, next]);
    if (this.buffer.length > this.maximumBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maximumBytes);
    }
  }

  contents(): Buffer {
    return this.buffer;
  }
}
