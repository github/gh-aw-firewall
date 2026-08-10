import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import {
  FIRECRACKER_RELEASE_VERSION,
  type FirecrackerOptions,
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
import { FirecrackerApiClient } from './api-client';
import { runFirecrackerPreflight } from './preflight';
import type { FirecrackerHostToolPaths } from './preflight';

const API_SOCKET_NAME = 'firecracker.socket';
const VSOCK_SOCKET_NAME = 'awf-vsock.socket';
const WORKSPACE_IMAGE_NAME = 'workspace.ext4';
const FIRECRACKER_LOG_NAME = 'firecracker.log';
const FIRECRACKER_METRICS_NAME = 'firecracker.metrics.jsonl';
const FIRECRACKER_CAPTURE_LIMIT_BYTES = 1024 * 1024;
const KERNEL_JAIL_PATH = '/kernel';
const ROOTFS_JAIL_PATH = '/rootfs';
const WORKSPACE_JAIL_PATH = '/workspace.ext4';
const VSOCK_JAIL_PATH = `/run/${VSOCK_SOCKET_NAME}`;
export const FIRECRACKER_GUEST_VSOCK_PORT = 52;
const FIRECRACKER_GUEST_SHUTDOWN_GRACE_MS = 5_000;

export interface FirecrackerRunPaths {
  runId: string;
  chrootBaseDir: string;
  jailRoot: string;
  apiSocketPath: string;
  kernelPath: string;
  rootfsPath: string;
  workspacePath: string;
  vsockSocketPath: string;
  logPath: string;
  metricsPath: string;
}

export interface FirecrackerManagerDependencies {
  preflight: typeof runFirecrackerPreflight;
  launch(
    command: string,
    args: string[],
    options: {
      reject: false;
      stdio: ['ignore', 'pipe', 'pipe'];
      env: NodeJS.ProcessEnv;
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
  createClient(socketPath: string, timeoutMs: number): FirecrackerApiClient;
  createNetwork(plan: MicrovmNetworkPlan, tools: FirecrackerHostToolPaths): MicrovmNetworkLifecycle;
  createWorkspaceImage(config: MicrovmWorkspaceImageConfig, tools: FirecrackerHostToolPaths): MicrovmWorkspaceImage;
  createVsockClient(socketPath: string, guestPort: number, timeoutMs: number): MicrovmVsockClient;
  resolveIdentity(): { uid: number; gid: number };
}

export interface FirecrackerManagerNetworkConfig {
  infrastructureBridge: string;
  enableApiProxy: boolean;
  controlPeer?: MicrovmControlPeer;
}

export interface FirecrackerManagerGuestConfig {
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

const defaultDependencies: FirecrackerManagerDependencies = {
  preflight: runFirecrackerPreflight,
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
  createClient: (socketPath, timeoutMs) => new FirecrackerApiClient({ socketPath, timeoutMs }),
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
  resolveIdentity: resolveJailerIdentity,
};

/** @internal Exposed only for focused host-adapter tests. */
export const firecrackerManagerTestHelpers = {
  defaultDependencies,
  resolveJailerIdentity,
};

function resolveJailerIdentity(): { uid: number; gid: number } {
  const operatorUid = parsePositiveIdentity(process.env.SUDO_UID) ?? process.getuid?.();
  const operatorGid = parsePositiveIdentity(process.env.SUDO_GID) ?? process.getgid?.();
  if (
    operatorUid === undefined ||
    operatorGid === undefined ||
    operatorUid === 0 ||
    operatorGid === 0
  ) {
    throw new Error(
      'Firecracker jailer requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  const uid = Number(getSafeHostUid());
  const gid = Number(getSafeHostGid());
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) {
    throw new Error(
      'Firecracker jailer requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  return { uid, gid };
}

function parsePositiveIdentity(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

export function createFirecrackerRunPaths(
  workDir: string,
  firecrackerBinary: string,
  runId = `awf-${process.pid}-${randomBytes(6).toString('hex')}`,
): FirecrackerRunPaths {
  assertSafeMicrovmRunId(runId);
  const chrootBaseDir = path.join(workDir, 'firecracker-jailer');
  const jailRoot = path.join(
    chrootBaseDir,
    path.basename(firecrackerBinary),
    runId,
    'root',
  );
  return {
    runId,
    chrootBaseDir,
    jailRoot,
    apiSocketPath: path.join(jailRoot, 'run', API_SOCKET_NAME),
    kernelPath: path.join(jailRoot, KERNEL_JAIL_PATH),
    rootfsPath: path.join(jailRoot, ROOTFS_JAIL_PATH),
    workspacePath: path.join(jailRoot, WORKSPACE_IMAGE_NAME),
    vsockSocketPath: path.join(jailRoot, 'run', VSOCK_SOCKET_NAME),
    logPath: path.join(jailRoot, 'run', FIRECRACKER_LOG_NAME),
    metricsPath: path.join(jailRoot, 'run', FIRECRACKER_METRICS_NAME),
  };
}

/**
 * Owns one jailer-launched Firecracker process and its partial-start cleanup.
 */
export class FirecrackerManager {
  readonly paths: FirecrackerRunPaths;
  private process: ExecaChildProcess<string> | undefined;
  private client: FirecrackerApiClient | undefined;
  private network: MicrovmNetworkLifecycle | undefined;
  private workspace: MicrovmWorkspaceImage | undefined;
  private guestClient: MicrovmVsockClient | undefined;
  private networkPlan: MicrovmNetworkPlan | undefined;
  private instanceStarted = false;
  private readonly stdoutCapture = new BoundedOutputCapture(FIRECRACKER_CAPTURE_LIMIT_BYTES);
  private readonly stderrCapture = new BoundedOutputCapture(FIRECRACKER_CAPTURE_LIMIT_BYTES);

  get guestIp(): string | undefined {
    return this.networkPlan?.guestIp;
  }

  get networkNamespace(): string | undefined {
    return this.networkPlan?.namespaceName;
  }

  constructor(
    private readonly config: FirecrackerOptions,
    private readonly workDir: string,
    private readonly dependencies: FirecrackerManagerDependencies = defaultDependencies,
    runId?: string,
    private readonly networkConfig?: FirecrackerManagerNetworkConfig,
    private readonly guestConfig?: FirecrackerManagerGuestConfig,
  ) {
    this.paths = createFirecrackerRunPaths(this.workDir, config.firecrackerBinary, runId);
  }

  async start(): Promise<FirecrackerApiClient> {
    if (!this.networkConfig) {
      throw new Error(
        'Firecracker network configuration is required; refusing to launch an unfiltered microVM',
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
      await this.dependencies.mkdir(this.paths.chrootBaseDir, {
        recursive: true,
        mode: 0o700,
      });

      this.process = this.dependencies.launch(
        this.config.jailerBinary,
        [
          '--id', this.paths.runId,
          '--exec-file', this.config.firecrackerBinary,
          '--uid', String(identity.uid),
          '--gid', String(identity.gid),
          '--chroot-base-dir', this.paths.chrootBaseDir,
          '--netns', networkPlan.netnsPath,
          '--cgroup-version', String(artifacts.cgroupVersion),
          '--',
          '--api-sock', `/run/${API_SOCKET_NAME}`,
        ],
        {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        },
      );
      this.process.stdout?.on('data', (chunk: Buffer | string) => {
        this.stdoutCapture.append(chunk);
      });
      this.process.stderr?.on('data', (chunk: Buffer | string) => {
        this.stderrCapture.append(chunk);
      });

      await this.waitForApiSocket();
      await this.stageArtifact(artifacts.kernelPath, this.paths.kernelPath, 0o400, identity);
      await this.stageArtifact(rootfsSource, this.paths.rootfsPath, 0o600, identity);
      if (workspaceSource) {
        await this.stageArtifact(workspaceSource, this.paths.workspacePath, 0o600, identity);
      }

      this.client = this.dependencies.createClient(
        this.paths.apiSocketPath,
        this.config.apiTimeoutMs,
      );
      await this.stageDiagnosticFile(this.paths.logPath, identity);
      await this.stageDiagnosticFile(this.paths.metricsPath, identity);
      await this.client.putLogger({
        log_path: `/run/${FIRECRACKER_LOG_NAME}`,
        level: 'Info',
        show_level: true,
        show_log_origin: true,
      });
      await this.client.putMetrics({
        metrics_path: `/run/${FIRECRACKER_METRICS_NAME}`,
      });
      await this.client.putMachineConfig({
        vcpu_count: this.config.vcpuCount,
        mem_size_mib: this.config.memoryMib,
      });
      await this.client.putBootSource({
        kernel_image_path: KERNEL_JAIL_PATH,
        ...(this.guestConfig
          ? { boot_args: buildSupervisorBootArgs(networkPlan, this.guestConfig) }
          : {}),
      });
      await this.client.putDrive({
        drive_id: 'rootfs',
        path_on_host: ROOTFS_JAIL_PATH,
        is_root_device: true,
        is_read_only: false,
      });
      await this.client.putNetworkInterface(networkPlan.networkInterface);
      if (this.guestConfig) {
        await this.client.putDrive({
          drive_id: 'workspace',
          path_on_host: WORKSPACE_JAIL_PATH,
          is_root_device: false,
          is_read_only: false,
        });
        await this.client.putVsock({
          guest_cid: 3,
          uds_path: VSOCK_JAIL_PATH,
        });
      }
      return this.client;
    } catch (error) {
      startupError = error;
    }

    try {
      await this.stop();
    } catch (cleanupError) {
      throw new Error(
        `Firecracker startup failed: ${formatError(startupError)}; ` +
        `partial-start cleanup also failed: ${formatError(cleanupError)}`,
      );
    }
    throw startupError;
  }

  async startInstance(): Promise<void> {
    if (!this.client) throw new Error('Firecracker API is not configured');
    await this.client.instanceStart();
    this.instanceStarted = true;
    if (this.guestConfig) {
      this.guestClient = this.dependencies.createVsockClient(
        this.paths.vsockSocketPath,
        this.guestConfig.vsockPort ?? FIRECRACKER_GUEST_VSOCK_PORT,
        this.config.apiTimeoutMs,
      );
      await this.guestClient.connect();
    }
  }

  async execute(
    request: GuestExecutionRequest,
  ): Promise<GuestExecutionResult> {
    if (!this.guestClient) {
      throw new Error('Firecracker guest supervisor is not ready');
    }
    return this.guestClient.execute(request);
  }

  cancel(reason = 'host cancellation', requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.cancel(reason, requestId);
  }

  writeStdin(data: Buffer, requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.writeStdin(data, requestId);
  }

  endStdin(requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
    }
    return this.guestClient.endStdin(requestId);
  }

  resize(columns: number, rows: number, requestId?: string): Promise<void> {
    if (!this.guestClient) {
      return Promise.reject(new Error('Firecracker guest supervisor is not ready'));
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
          error.message !== 'Cannot shut down Firecracker guest while a request is running'
        ) {
          errors.push(error);
        }
        this.guestClient.destroy();
      }
    }
    this.guestClient = undefined;

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
        if (guestShutdownAcknowledged) {
          terminationConfirmed = await this.waitForProcessExit(
            child,
            FIRECRACKER_GUEST_SHUTDOWN_GRACE_MS,
          );
        }
        if (!child.killed) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM', { forceKillAfterTimeout: 2_000 });
          }
        }
        if (!terminationConfirmed) {
          await child;
          if (child.exitCode === null && child.signalCode === null) {
            throw new Error('Firecracker process termination was not confirmed');
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
        errors.push(new Error('Firecracker process termination was not confirmed'));
      }
      throw new Error(
        `Firecracker cleanup stopped before workspace/network removal: ` +
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
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new Error(
          `Firecracker preservation failed: ${errors.map(formatError).join('; ')}`,
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

    if (!instanceWasStarted || terminationConfirmed) {
      try {
        await this.dependencies.rm(
          path.join(
            this.paths.chrootBaseDir,
            path.basename(this.config.firecrackerBinary),
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
        `Firecracker cleanup failed: ${errors.map(formatError).join('; ')}`,
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
    if (this.client && this.instanceStarted) {
      await this.client.putAction('FlushMetrics');
      await this.dependencies.sleep(25);
    }
    const writeBounded = async (fileName: string, contents: Buffer): Promise<void> => {
      const destination = path.join(directory, fileName);
      await this.dependencies.writeFile(destination, contents, { mode: 0o600 });
    };
    await writeBounded('jailer-stdout.log', this.stdoutCapture.contents());
    await writeBounded('jailer-stderr.log', this.stderrCapture.contents());
    await this.copyBoundedDiagnostic(
      this.paths.logPath,
      path.join(directory, FIRECRACKER_LOG_NAME),
    );
    await this.copyBoundedDiagnostic(
      this.paths.metricsPath,
      path.join(directory, FIRECRACKER_METRICS_NAME),
    );
    await this.dependencies.writeFile(
      path.join(directory, 'network-plan.json'),
      `${JSON.stringify(this.networkPlan ?? null, null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.dependencies.writeFile(
      path.join(directory, 'runtime.json'),
      `${JSON.stringify({
        runtime: 'firecracker',
        version: FIRECRACKER_RELEASE_VERSION,
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
          `Firecracker jailer exited before API readiness with code ${this.process.exitCode ?? 'null'} ` +
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
      `Firecracker API socket was not ready after ${this.config.apiTimeoutMs}ms: ` +
      this.paths.apiSocketPath,
    );
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
      const bounded = await this.dependencies.readFileTail(source, FIRECRACKER_CAPTURE_LIMIT_BYTES);
      await this.dependencies.writeFile(destination, bounded, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function buildSupervisorBootArgs(
  networkPlan: MicrovmNetworkPlan,
  guestConfig: FirecrackerManagerGuestConfig,
): string {
  const port = guestConfig.vsockPort ?? FIRECRACKER_GUEST_VSOCK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Firecracker guest vsock port must be in 1-65535: ${port}`);
  }
  return [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
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
