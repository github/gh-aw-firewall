import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import type { FirecrackerOptions } from '../types/runtime-options';
import { FirecrackerApiClient } from './api-client';
import {
  FirecrackerNetworkManager,
  assertSafeFirecrackerRunId,
  createFirecrackerNetworkPlan,
  type FirecrackerControlPeer,
  type FirecrackerNetworkLifecycle,
  type FirecrackerNetworkPlan,
} from './network';
import { runFirecrackerPreflight } from './preflight';

const API_SOCKET_NAME = 'firecracker.socket';
const KERNEL_JAIL_PATH = '/kernel';
const ROOTFS_JAIL_PATH = '/rootfs';

export interface FirecrackerRunPaths {
  runId: string;
  chrootBaseDir: string;
  jailRoot: string;
  apiSocketPath: string;
  kernelPath: string;
  rootfsPath: string;
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
  access(filePath: string): Promise<void>;
  rm(directory: string, options: { recursive: true; force: true }): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  createClient(socketPath: string, timeoutMs: number): FirecrackerApiClient;
  createNetwork(plan: FirecrackerNetworkPlan): FirecrackerNetworkLifecycle;
  resolveIdentity(): { uid: number; gid: number };
}

export interface FirecrackerManagerNetworkConfig {
  infrastructureBridge: string;
  enableApiProxy: boolean;
  controlPeer?: FirecrackerControlPeer;
}

const defaultDependencies: FirecrackerManagerDependencies = {
  preflight: runFirecrackerPreflight,
  launch: (command, args, options) => execa(command, args, options),
  mkdir: fs.mkdir,
  copyFile: fs.copyFile,
  chmod: fs.chmod,
  chown: fs.chown,
  access: fs.access,
  rm: fs.rm,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  createClient: (socketPath, timeoutMs) => new FirecrackerApiClient({ socketPath, timeoutMs }),
  createNetwork: (plan) => new FirecrackerNetworkManager(plan),
  resolveIdentity: resolveJailerIdentity,
};

function parsePositiveIdentity(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

function resolveJailerIdentity(): { uid: number; gid: number } {
  const uid = parsePositiveIdentity(process.env.SUDO_UID) ?? process.getuid?.();
  const gid = parsePositiveIdentity(process.env.SUDO_GID) ?? process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) {
    throw new Error(
      'Firecracker jailer requires a non-root target uid/gid; run through sudo from a non-root account',
    );
  }
  return { uid, gid };
}

export function createFirecrackerRunPaths(
  workDir: string,
  firecrackerBinary: string,
  runId = `awf-${process.pid}-${randomBytes(6).toString('hex')}`,
): FirecrackerRunPaths {
  assertSafeFirecrackerRunId(runId);
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
  };
}

/**
 * Owns one jailer-launched Firecracker process and its partial-start cleanup.
 */
export class FirecrackerManager {
  readonly paths: FirecrackerRunPaths;
  private process: ExecaChildProcess<string> | undefined;
  private client: FirecrackerApiClient | undefined;
  private network: FirecrackerNetworkLifecycle | undefined;

  constructor(
    private readonly config: FirecrackerOptions,
    workDir: string,
    private readonly dependencies: FirecrackerManagerDependencies = defaultDependencies,
    runId?: string,
    private readonly networkConfig?: FirecrackerManagerNetworkConfig,
  ) {
    this.paths = createFirecrackerRunPaths(workDir, config.firecrackerBinary, runId);
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
      const identity = this.dependencies.resolveIdentity();
      const networkPlan = createFirecrackerNetworkPlan(this.paths.runId, {
        ...this.networkConfig,
        jailerUid: identity.uid,
        jailerGid: identity.gid,
      });
      this.network = this.dependencies.createNetwork(networkPlan);
      await this.network.setup();
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
          '--',
          '--api-sock', `/run/${API_SOCKET_NAME}`,
        ],
        {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        },
      );

      await this.waitForApiSocket();
      await this.stageArtifact(artifacts.kernelPath, this.paths.kernelPath, 0o400, identity);
      await this.stageArtifact(artifacts.rootfsPath, this.paths.rootfsPath, 0o600, identity);

      this.client = this.dependencies.createClient(
        this.paths.apiSocketPath,
        this.config.apiTimeoutMs,
      );
      await this.client.putMachineConfig({
        vcpu_count: this.config.vcpuCount,
        mem_size_mib: this.config.memoryMib,
      });
      await this.client.putBootSource({
        kernel_image_path: KERNEL_JAIL_PATH,
      });
      await this.client.putDrive({
        drive_id: 'rootfs',
        path_on_host: ROOTFS_JAIL_PATH,
        is_root_device: true,
        is_read_only: false,
      });
      await this.client.putNetworkInterface(networkPlan.networkInterface);
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
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    if (this.process && this.process.exitCode === null && !this.process.killed) {
      const child = this.process;
      try {
        child.kill('SIGTERM', { forceKillAfterTimeout: 2_000 });
        await child;
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error('Firecracker process termination was not confirmed');
        }
      } catch (error) {
        errors.push(error);
      }
    }
    this.process = undefined;
    this.client = undefined;

    try {
      await this.network?.cleanup();
    } catch (error) {
      errors.push(error);
    }
    this.network = undefined;

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

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new Error(
        `Firecracker cleanup failed: ${errors.map(formatError).join('; ')}`,
      );
    }
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
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
