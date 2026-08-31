import { promises as fs } from 'fs';
import type { PathLike } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMicrovmNetworkPlan } from '../microvm/network';
import {
  DurableCloudHypervisorCleanupRegistry,
  type CleanupRegistryDependencies,
} from './cleanup-registry';
import type { CloudHypervisorRunPaths } from './manager-types';

function procStat(pid: number, startTime: string): string {
  return `${pid} (node) S ${Array(18).fill('0').join(' ')} ${startTime}\n`;
}

function procStatus(uid = 0, gid = 0): string {
  return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\n`;
}

describe('DurableCloudHypervisorCleanupRegistry', () => {
  let temporaryRoot: string;
  let ownerStartTime: string;
  let daemonNamespace: string;
  let mountInfo: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-cleanup-registry-'));
    ownerStartTime = '1000';
    daemonNamespace = 'net:[5000]';
    mountInfo = '';
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

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
        if (name === '/proc/4242/stat') return procStat(4242, ownerStartTime);
        if (name === '/proc/4242/status') return procStatus();
        if (name === '/proc/4242/cmdline') return 'node\0test\0';
        if (name === '/proc/5000/stat') return procStat(5000, '5000');
        if (name === '/proc/5000/status') return procStatus();
        if (name === '/proc/5000/cmdline') return `${process.execPath}\0--socket-path=/sock\0--shared-dir=/source\0`;
        if (name === '/proc/self/mountinfo') return mountInfo;
        return fs.readFile(filePath, options as never);
      }) as typeof fs.readFile,
      readlink: (async (filePath: PathLike) => {
        if (String(filePath) === '/proc/4242/ns/net') return 'net:[4026531840]';
        if (String(filePath) === '/proc/5000/ns/net') return daemonNamespace;
        return fs.readlink(filePath);
      }) as typeof fs.readlink,
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

  function networkPlan(runId: string) {
    return createMicrovmNetworkPlan(runId, {
      infrastructureBridge: 'awfbr0',
      enableApiProxy: true,
      tapOwnerUid: 1000,
      tapOwnerGid: 1000,
    });
  }

  it('atomically creates a private record before any resource identity is live', async () => {
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const paths = runPaths('recorded-run');
    const plan = networkPlan(paths.runId);

    await registry.create(paths, plan, process.execPath, '/usr/bin/ip');

    const recordPath = path.join(temporaryRoot, 'pending-cleanup', 'recorded-run.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
      owner: { pid: number; startTime: string; executable: string };
      paths: { runDirectory: string; cgroupPath: string };
      network: { namespaceName: string; hostVethName: string; tapName: string };
      identities: Record<string, unknown>;
    };
    expect(record.owner).toMatchObject({
      pid: 4242,
      startTime: '1000',
      executable: await fs.realpath(process.execPath),
    });
    expect(record.paths).toEqual({
      runDirectory: paths.runDirectory,
      cgroupPath: paths.cgroupPath,
      virtiofsdShareDirectory: paths.virtiofsdShareDirectory,
    });
    expect(record.network).toMatchObject({
      namespaceName: plan.namespaceName,
      hostVethName: plan.hostVethName,
      tapName: plan.tapName,
    });
    expect(record.identities).toEqual({});
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(recordPath))).mode & 0o777).toBe(0o700);
  });

  it('skips a live owner so sibling runs cannot reap each other', async () => {
    const deps = dependencies();
    const registry = new DurableCloudHypervisorCleanupRegistry(deps);
    const paths = runPaths('active-run');
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).resolves.toBeUndefined();

    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', 'active-run.json'),
    )).resolves.toBeUndefined();
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it('reaps an abandoned pre-resource record after owner PID reuse', async () => {
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const paths = runPaths('stale-run');
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', 'stale-run.json'),
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('atomically takes over and removes a stale cleanup claim', async () => {
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const paths = runPaths('stale-claim');
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', 'stale-claim.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { owner: unknown };
    await fs.writeFile(`${recordPath}.lock`, `${JSON.stringify(record.owner)}\n`, { mode: 0o600 });
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    const names = await fs.readdir(path.dirname(recordPath));
    expect(names.filter((name) => name.startsWith('stale-claim.json'))).toEqual([]);
  });

  it('retains evidence and fails when a live resource lacks a committed identity', async () => {
    const base = dependencies();
    const originalLstat = base.lstat as typeof fs.lstat;
    const plan = networkPlan('uncertain-run');
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      if (String(filePath) === plan.netnsPath) {
        const bigint = Boolean((options as { bigint?: boolean } | undefined)?.bigint);
        return {
          dev: bigint ? 1n : 1,
          ino: bigint ? 2n : 2,
          uid: bigint ? 0n : 0,
          mode: bigint ? 0o100600n : 0o100600,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      }
      return originalLstat(filePath, options as never);
    }) as typeof fs.lstat;
    const registry = new DurableCloudHypervisorCleanupRegistry({ ...base, lstat });
    const paths = runPaths(plan.runId);
    await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /netns exists but its immutable identity was never committed/,
    );
    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', 'uncertain-run.json'),
    )).resolves.toBeUndefined();
  });

  it('records the settled private network namespace of sandboxed virtiofsd', async () => {
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const paths = runPaths('virtiofsd-netns');
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );

    await handle.prepareProcess('virtiofsd-0', process.execPath, '/sock', '/source');
    await handle.captureProcess('virtiofsd-0', 5000);

    const record = JSON.parse(await fs.readFile(
      path.join(temporaryRoot, 'pending-cleanup', 'virtiofsd-netns.json'),
      'utf8',
    )) as { processes: Record<string, { identity: { networkNamespace: string } }> };
    expect(record.processes['virtiofsd-0'].identity.networkNamespace).toBe('net:[5000]');
  });

  it('revalidates and unmounts recorded virtiofs bind mounts deepest-first', async () => {
    const run = jest.fn(async (command: string) => {
      if (command === '/usr/bin/umount') {
        mountInfo = '';
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'Device does not exist' };
    });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ run }));
    const paths = runPaths('mounted-run');
    const mountPoint = path.join(paths.virtiofsdShareDirectory, '0-workspace');
    await fs.mkdir(mountPoint, { recursive: true });
    mountInfo = `123 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw\n`;
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureVirtiofsdResources();
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    expect(run).toHaveBeenCalledWith('/usr/bin/umount', [mountPoint]);
    await expect(fs.access(paths.virtiofsdShareDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries inode-validated cgroup removal while kernel accounting drains', async () => {
    const paths = runPaths('cgroup-drain');
    await fs.mkdir(paths.cgroupPath, { recursive: true });
    let attempts = 0;
    const rmdir = jest.fn(async (directory: PathLike) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      await fs.rmdir(directory);
    }) as typeof fs.rmdir;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ rmdir }));
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureCgroup();
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    expect(rmdir).toHaveBeenCalledTimes(2);
    await expect(fs.access(paths.cgroupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
