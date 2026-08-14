import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ExecaChildProcess } from 'execa';
import {
  assertSafeMicrovmRunId,
  type MicrovmControlPeer,
  type MicrovmNetworkLifecycle,
  type MicrovmNetworkPlan,
} from '../microvm/network';
import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type { MicrovmRootfsConfig, MicrovmRootfsPreparer } from '../microvm/rootfs';
import type { CloudHypervisorApiClient } from './api-client';
import type { CloudHypervisorDirectoryExport } from './exports';
import type { CloudHypervisorCgroup, CloudHypervisorResourceLimits } from './launcher';
import type { CloudHypervisorHostToolPaths, runCloudHypervisorPreflight } from './preflight';
import type { VirtiofsdManager } from './virtiofsd';

const API_SOCKET_NAME = 'api.socket';
const VSOCK_SOCKET_NAME = 'awf-vsock.socket';
const KERNEL_RUN_NAME = 'kernel';
const ROOTFS_RUN_NAME = 'rootfs.ext4';
export const CLOUD_HYPERVISOR_LOG_NAME = 'cloud-hypervisor.log';
export const CLOUD_HYPERVISOR_SERIAL_LOG_NAME = 'serial.log';
export const CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES = 1024 * 1024;
export const CLOUD_HYPERVISOR_GUEST_VSOCK_PORT = 52;
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
  createRootfsPreparer(
    config: MicrovmRootfsConfig,
    tools: CloudHypervisorHostToolPaths,
  ): MicrovmRootfsPreparer;
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

export interface CloudHypervisorIdentity {
  uid: number;
  gid: number;
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

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
