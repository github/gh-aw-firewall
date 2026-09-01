import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import type { PathLike } from 'fs';
import * as path from 'path';
import { createMicrovmNetworkPlan, type MicrovmNetworkPlan } from '../microvm/network';
import type { CleanupRegistryDependencies } from './cleanup-registry';
import type { CloudHypervisorRunPaths } from './manager-types';

function procStat(pid: number, startTime: string): string {
  return `${pid} (node) S ${Array(18).fill('0').join(' ')} ${startTime}
`;
}

function procStatus(uid = 0, gid = 0): string {
  return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\n`;
}

export interface CleanupRegistryTestState {
  ownerStartTime: string;
  ownerExecutableLink: string;
  daemonExecutableLink: string;
  daemonCmdline: string;
  daemonAlive: boolean;
  daemonNamespace: string;
  mountInfo: string;
}

export interface CleanupRegistryTestHarness {
  readonly temporaryRoot: string;
  readonly state: CleanupRegistryTestState;
  dependencies(overrides?: CleanupRegistryDependencies): CleanupRegistryDependencies;
  runPaths(runId: string): CloudHypervisorRunPaths;
  networkPlan(runId: string): MicrovmNetworkPlan;
  mutateRecord(runId: string, mutate: (record: Record<string, any>) => void): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createCleanupRegistryTestHarness(): Promise<CleanupRegistryTestHarness> {
  const workspace = path.join(process.cwd(), '.test-workdir');
  await fs.mkdir(workspace, { recursive: true });
  const temporaryRoot = path.join(workspace, `awf-cleanup-registry-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(temporaryRoot, { recursive: true });
  const state: CleanupRegistryTestState = {
    ownerStartTime: '1000',
    ownerExecutableLink: process.execPath,
    daemonExecutableLink: process.execPath,
    daemonCmdline: `${process.execPath}\0--socket-path=/sock\0--shared-dir=/source\0`,
    daemonAlive: true,
    daemonNamespace: 'net:[5000]',
    mountInfo: '',
  };

  function dependencies(overrides: CleanupRegistryDependencies = {}): CleanupRegistryDependencies {
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      const value = await fs.lstat(filePath, options as never);
      if (typeof value.uid === 'bigint') return Object.assign(value, { uid: 0n });
      return Object.assign(value, { uid: 0 });
    }) as typeof fs.lstat;
    return {
      rootDirectory: temporaryRoot,
      effectiveUid: 0,
      processId: 4242,
      lstat,
      readFile: (async (filePath: PathLike, options?: unknown) => {
        const name = String(filePath);
        if (name === '/proc/4242/stat') return procStat(4242, state.ownerStartTime);
        if (name === '/proc/4242/status') return procStatus();
        if (name === '/proc/4242/cmdline') return 'node\0test\0';
        if (name.startsWith('/proc/5000/') && !state.daemonAlive) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        if (name === '/proc/5000/stat') return procStat(5000, '5000');
        if (name === '/proc/5000/status') return procStatus();
        if (name === '/proc/5000/cmdline') return state.daemonCmdline;
        if (name === '/proc/self/mountinfo') return state.mountInfo;
        return fs.readFile(filePath, options as never);
      }) as typeof fs.readFile,
      readlink: (async (filePath: PathLike) => {
        if (String(filePath) === '/proc/4242/exe') return state.ownerExecutableLink;
        if (String(filePath) === '/proc/5000/exe') return state.daemonExecutableLink;
        if (String(filePath) === '/proc/4242/ns/net') return 'net:[4026531840]';
        if (String(filePath) === '/proc/5000/ns/net') return state.daemonNamespace;
        return fs.readlink(filePath);
      }) as typeof fs.readlink,
      stat: (async (filePath: PathLike, options?: unknown) => {
        const name = String(filePath);
        if (name === '/proc/4242/exe' || name === '/proc/5000/exe') {
          return fs.stat(process.execPath, options as never);
        }
        return fs.stat(filePath, options as never);
      }) as typeof fs.stat,
      realpath: (async (filePath: PathLike) => {
        if (String(filePath) === '/proc/4242/exe') return process.execPath;
        if (String(filePath) === '/proc/5000/exe') return process.execPath;
        return fs.realpath(filePath);
      }) as typeof fs.realpath,
      run: jest.fn(async (_command: string, args: readonly string[]) => ({
        exitCode: 1,
        stdout: '',
        stderr: args.includes('netns')
          ? 'Cannot open network namespace "missing": No such file or directory'
          : 'Device does not exist',
      })),
      kill: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function runPaths(runId: string): CloudHypervisorRunPaths {
    const runBaseDir = path.join(temporaryRoot, 'runs');
    const runDirectory = path.join(runBaseDir, 'cloud-hypervisor', runId);
    return {
      runId,
      runBaseDir,
      runDirectory,
      apiSocketPath: path.join(runDirectory, 'api.socket'),
      kernelPath: path.join(runDirectory, 'kernel'),
      rootfsPath: path.join(runDirectory, 'rootfs.ext4'),
      vsockSocketPath: path.join(runDirectory, 'awf-vsock.socket'),
      logPath: path.join(runDirectory, 'cloud-hypervisor.log'),
      serialLogPath: path.join(runDirectory, 'serial.log'),
      virtiofsdShareDirectory: path.join(runBaseDir, 'virtiofsd', runId),
      cgroupPath: path.join(temporaryRoot, 'cgroup', runId),
    };
  }

  function networkPlan(runId: string): MicrovmNetworkPlan {
    return createMicrovmNetworkPlan(runId, {
      infrastructureBridge: 'awfbr0',
      enableApiProxy: true,
      tapOwnerUid: 1000,
      tapOwnerGid: 1000,
    });
  }

  async function mutateRecord(
    runId: string,
    mutate: (record: Record<string, any>) => void,
  ): Promise<void> {
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${runId}.json`);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as Record<string, any>;
    mutate(record);
    await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  return {
    temporaryRoot,
    state,
    dependencies,
    runPaths,
    networkPlan,
    mutateRecord,
    cleanup: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
  };
}
