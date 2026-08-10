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
  MicrovmWorkspaceImage,
  type MicrovmWorkspaceImageConfig,
} from '../microvm/workspace';
import { CloudHypervisorApiClient } from './api-client';
import {
  CLOUD_HYPERVISOR_GUEST_CID,
  CloudHypervisorCgroup,
  buildCloudHypervisorLaunchCommand,
  computeCloudHypervisorLandlockRules,
  type CloudHypervisorResourceLimits,
} from './launcher';
import { runCloudHypervisorPreflight } from './preflight';
import type { CloudHypervisorHostToolPaths } from './preflight';

const API_SOCKET_NAME = 'api.socket';
const VSOCK_SOCKET_NAME = 'awf-vsock.socket';
const WORKSPACE_IMAGE_NAME = 'workspace.ext4';
const KERNEL_RUN_NAME = 'kernel';
const ROOTFS_RUN_NAME = 'rootfs.ext4';
const CLOUD_HYPERVISOR_LOG_NAME = 'cloud-hypervisor.log';
const CLOUD_HYPERVISOR_SERIAL_LOG_NAME = 'serial.log';
const CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES = 1024 * 1024;
export const CLOUD_HYPERVISOR_GUEST_VSOCK_PORT = 52;
const CLOUD_HYPERVISOR_GUEST_SHUTDOWN_GRACE_MS = 5_000;
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
  workspacePath: string;
  vsockSocketPath: string;
  logPath: string;
  serialLogPath: string;
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
  createWorkspaceImage(config: MicrovmWorkspaceImageConfig, tools: CloudHypervisorHostToolPaths): MicrovmWorkspaceImage;
  createVsockClient(socketPath: string, guestPort: number, timeoutMs: number): MicrovmVsockClient;
  createCgroup(cgroupPath: string, limits: CloudHypervisorResourceLimits): CloudHypervisorCgroup;
  resolveIdentity(): { uid: number; gid: number };
}

export interface CloudHypervisorManagerNetworkConfig {
  infrastructureBridge: string;
  enableApiProxy: boolean;
  controlPeer?: MicrovmControlPeer;
}

export interface CloudHypervisorManagerGuestConfig {
  readonly workspacePath: string;
  readonly homePath: string;
  readonly supervisorBinaryPath: string;
  readonly supervisorSha256: string;
  readonly maxWorkspaceImageBytes?: number;
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
  createWorkspaceImage: (config, tools) => new MicrovmWorkspaceImage(config, undefined, tools),
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
    workspacePath: path.join(runDirectory, WORKSPACE_IMAGE_NAME),
    vsockSocketPath: path.join(runDirectory, VSOCK_SOCKET_NAME),
    logPath: path.join(runDirectory, CLOUD_HYPERVISOR_LOG_NAME),
    serialLogPath: path.join(runDirectory, CLOUD_HYPERVISOR_SERIAL_LOG_NAME),
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
  private workspace: MicrovmWorkspaceImage | undefined;
  private guestClient: MicrovmVsockClient | undefined;
  private cgroup: CloudHypervisorCgroup | undefined;
  private networkPlan: MicrovmNetworkPlan | undefined;
  private instanceStarted = false;
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
      });
      this.networkPlan = networkPlan;
      this.network = this.dependencies.createNetwork(networkPlan, artifacts.tools);
      await this.network.setup();
      let rootfsSource = artifacts.rootfsPath;
      let workspaceSource: string | undefined;
      if (this.guestConfig) {
        this.workspace = this.dependencies.createWorkspaceImage({
          runId: this.paths.runId,
          workDir: this.workDir,
          workspacePath: this.guestConfig.workspacePath,
          homePath: this.guestConfig.homePath,
          baseRootfsPath: artifacts.rootfsPath,
          supervisorBinaryPath: this.guestConfig.supervisorBinaryPath,
          supervisorSha256: this.guestConfig.supervisorSha256,
          ...(this.guestConfig.maxWorkspaceImageBytes === undefined
            ? {}
            : { maxImageBytes: this.guestConfig.maxWorkspaceImageBytes }),
          uid: identity.uid,
          gid: identity.gid,
        }, artifacts.tools);
        const preparation = await this.workspace.prepare();
        rootfsSource = preparation.rootfsImagePath;
        workspaceSource = preparation.workspaceImagePath;
      }

      await this.prepareRunDirectory(identity);

      this.cgroup = this.dependencies.createCgroup(
        this.paths.cgroupPath,
        { memoryMib: this.config.memoryMib, vcpuCount: this.config.vcpuCount },
      );
      await this.cgroup.setup();

      await this.stageArtifact(artifacts.kernelPath, this.paths.kernelPath, 0o400, identity);
      await this.stageArtifact(rootfsSource, this.paths.rootfsPath, 0o600, identity);
      if (workspaceSource) {
        await this.stageArtifact(workspaceSource, this.paths.workspacePath, 0o600, identity);
      }
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
      workspacePath: this.guestConfig ? this.paths.workspacePath : undefined,
      runDirectory: this.paths.runDirectory,
      apiSocketPath: this.paths.apiSocketPath,
      vsockSocketPath: this.paths.vsockSocketPath,
    });
    return {
      cpus: {
        boot_vcpus: this.config.vcpuCount,
        max_vcpus: this.config.vcpuCount,
      },
      memory: {
        size: this.config.memoryMib * 1024 * 1024,
      },
      payload: {
        kernel: this.paths.kernelPath,
        ...(this.guestConfig
          ? { cmdline: buildSupervisorBootArgs(networkPlan, this.guestConfig) }
          : {}),
      },
      disks: [
        { id: 'rootfs', path: this.paths.rootfsPath, readonly: false },
        ...(this.guestConfig
          ? [{ id: 'workspace', path: this.paths.workspacePath, readonly: false }]
          : []),
      ],
      net: [{
        id: 'net0',
        tap: networkPlan.networkInterface.host_dev_name,
        mac: networkPlan.networkInterface.guest_mac ?? '',
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
      this.guestClient = this.dependencies.createVsockClient(
        this.paths.vsockSocketPath,
        this.guestConfig.vsockPort ?? CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
        this.config.apiTimeoutMs,
      );
      await this.guestClient.connect();
    }
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

  async stop(options: { preserve?: boolean } = {}): Promise<void> {
    const errors: unknown[] = [];
    const instanceWasStarted = this.instanceStarted;
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
      throw new Error(
        `Cloud Hypervisor cleanup stopped before workspace/network removal: ` +
        `${errors.map(formatError).join('; ')}`,
      );
    }
    this.process = undefined;
    this.client = undefined;

    if (this.workspace && instanceWasStarted) {
      try {
        await this.workspace.extractAfterStop(this.paths.workspacePath);
      } catch (error) {
        errors.push(error);
      }
    }
    this.instanceStarted = false;

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

    try {
      await this.workspace?.cleanup(!instanceWasStarted);
    } catch (error) {
      errors.push(error);
    }
    this.workspace = undefined;

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
    let counters: unknown = null;
    if (this.client && this.instanceStarted) {
      try {
        counters = await this.client.vmCounters();
      } catch {
        counters = null;
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
    await this.dependencies.writeFile(
      path.join(directory, 'network-plan.json'),
      `${JSON.stringify(this.networkPlan ?? null, null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.dependencies.writeFile(
      path.join(directory, 'counters.json'),
      `${JSON.stringify(counters, null, 2)}\n`,
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
    'panic=1',
    'root=/dev/vda',
    'rootfstype=ext4',
    'rootflags=data=ordered',
    'rw',
    // Cloud Hypervisor requires PCI (no `pci=off` MMIO-only mode like
    // Firecracker); pin legacy `ethN` interface naming so the guest's
    // single virtio-pci NIC has a deterministic name across boots.
    'net.ifnames=0',
    'biosdevname=0',
    'init=/sbin/awf-supervisor',
    'awf.workspace-device=/dev/vdb',
    'awf.workspace-mount=/workspace',
    `awf.vsock-port=${port}`,
    `awf.guest-ip=${networkPlan.guestIp}`,
    `awf.guest-prefix=${networkPlan.guestPrefixLength}`,
    `awf.guest-gateway=${networkPlan.guestGatewayIp}`,
    'awf.guest-interface=eth0',
  ].join(' ');
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
