import { promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import {
  LinuxNetworkCommands,
  MicrovmNetworkManager,
  createMicrovmNetworkPlan,
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
  prepareRunDirectory,
  readBoundedTail,
  stageArtifact,
  stageDiagnosticFile,
  waitForApiSocket,
} from './diagnostics';
import {
  CloudHypervisorGuestChannel,
} from './guest-execution';
import {
  CloudHypervisorCgroup,
  buildCloudHypervisorLaunchCommand,
} from './launcher';
import {
  CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES,
  CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
  createCloudHypervisorRunPaths,
  formatError,
  type CloudHypervisorIdentity,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorManagerGuestConfig,
  type CloudHypervisorManagerNetworkConfig,
  type CloudHypervisorRunPaths,
} from './manager-types';
import { runCloudHypervisorPreflight } from './preflight';
import type { CloudHypervisorHostToolPaths } from './preflight';
import {
  validateCloudHypervisorExports,
} from './exports';
import { VirtiofsdManager, type VirtiofsdDevice } from './virtiofsd';
import {
  buildCloudHypervisorVmConfig,
} from './vm-config-builder';

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

const CLOUD_HYPERVISOR_GUEST_SHUTDOWN_GRACE_MS = 5_000;
const CLOUD_HYPERVISOR_GUEST_SUPERVISOR = '/usr/sbin/awf-supervisor';

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
 * `./launcher.ts` (network-namespace join + privilege drop + Landlock, in
 * place of Firecracker's jailer) and its partial-start cleanup.
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

      await prepareRunDirectory(this.dependencies, this.paths, identity);

      this.cgroup = this.dependencies.createCgroup(
        this.paths.cgroupPath,
        { memoryMib: this.config.memoryMib, vcpuCount: this.config.vcpuCount },
      );
      await this.cgroup.setup();

      await stageArtifact(
        this.dependencies, artifacts.kernelPath, this.paths.kernelPath, 0o400, identity,
      );
      await stageArtifact(
        this.dependencies, rootfsSource, this.paths.rootfsPath, 0o600, identity,
      );
      await stageDiagnosticFile(this.dependencies, this.paths.logPath, identity);
      await stageDiagnosticFile(this.dependencies, this.paths.serialLogPath, identity);

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

      await waitForApiSocket(
        this.dependencies,
        this.paths,
        this.config.apiTimeoutMs,
        this.process,
      );
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
      await this.client.vmCreate(buildCloudHypervisorVmConfig({
        config: this.config,
        paths: this.paths,
        networkPlan,
        ...(this.guestConfig ? { guestConfig: this.guestConfig } : {}),
        fsDevices: this.fsDevices,
      }));
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
    if (this.guest) {
      const outcome = await this.guest.shutdown();
      guestShutdownAcknowledged = outcome.acknowledged;
      if (outcome.error !== undefined) errors.push(outcome.error);
    }
    this.guest = undefined;

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
