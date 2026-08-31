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
  let ownerExecutableLink: string;
  let daemonExecutableLink: string;
  let daemonCmdline: string;
  let daemonAlive: boolean;
  let daemonNamespace: string;
  let mountInfo: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-cleanup-registry-'));
    ownerStartTime = '1000';
    ownerExecutableLink = process.execPath;
    daemonExecutableLink = process.execPath;
    daemonCmdline = `${process.execPath}\0--socket-path=/sock\0--shared-dir=/source\0`;
    daemonAlive = true;
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
        if (name.startsWith('/proc/5000/') && !daemonAlive) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        if (name === '/proc/5000/stat') return procStat(5000, '5000');
        if (name === '/proc/5000/status') return procStatus();
        if (name === '/proc/5000/cmdline') return daemonCmdline;
        if (name === '/proc/self/mountinfo') return mountInfo;
        return fs.readFile(filePath, options as never);
      }) as typeof fs.readFile,
      readlink: (async (filePath: PathLike) => {
        if (String(filePath) === '/proc/4242/exe') return ownerExecutableLink;
        if (String(filePath) === '/proc/5000/exe') return daemonExecutableLink;
        if (String(filePath) === '/proc/4242/ns/net') return 'net:[4026531840]';
        if (String(filePath) === '/proc/5000/ns/net') return daemonNamespace;
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

  function networkPlan(runId: string) {
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

  it('journals and reaps the exact dedicated VMM account and ACL identity', async () => {
    const paths = runPaths('vmm-account-recovery');
    const account = 'awfvmm-0123456789abcdef0123';
    let userExists = true;
    let groupExists = true;
    let aclExists = true;
    const tools = {
      getfacl: '/usr/bin/getfacl',
      getent: '/usr/bin/getent',
      groupdel: '/usr/sbin/groupdel',
      id: '/usr/bin/id',
      ip: '/usr/bin/ip',
      setfacl: '/usr/bin/setfacl',
      useradd: '/usr/sbin/useradd',
      userdel: '/usr/sbin/userdel',
    };
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent && args[0] === 'passwd') {
        return userExists
          ? {
            exitCode: 0,
            stdout: `${account}:x:23001:23002:AWF Cloud Hypervisor ${paths.runId}:` +
              '/nonexistent:/usr/sbin/nologin\n',
            stderr: '',
          }
          : { exitCode: 2, stdout: '', stderr: '' };
      }
      if (command === tools.getent && args[0] === 'group') {
        return groupExists
          ? { exitCode: 0, stdout: `${account}:x:23002:\n`, stderr: '' }
          : { exitCode: 2, stdout: '', stderr: '' };
      }
      if (command === tools.getfacl) {
        return {
          exitCode: 0,
          stdout: aclExists ? 'user:23001:rw-\n' : '',
          stderr: '',
        };
      }
      if (command === tools.id) {
        if (!userExists) return { exitCode: 1, stdout: '', stderr: '' };
        if (args[0] === '-u') return { exitCode: 0, stdout: '23001\n', stderr: '' };
        return { exitCode: 0, stdout: '23002\n', stderr: '' };
      }
      if (command === tools.setfacl) aclExists = false;
      if (command === tools.userdel) userExists = false;
      if (command === tools.groupdel) groupExists = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ run }));
    const handle = await registry.createPending(paths, process.execPath, tools.ip);
    const snapshot = path.join(paths.runBaseDir, 'trusted-artifacts', 'run-snapshot');
    await fs.mkdir(snapshot, { recursive: true });
    await handle.captureArtifactSnapshot(snapshot);
    await handle.prepareVmmAccount(account);
    await handle.captureVmmIdentity({ name: account, uid: 23001, gid: 23002 });
    await handle.prepareVmmAcl('/dev/kvm');
    ownerStartTime = '2000';

    await registry.reapPending(tools.ip, '/usr/bin/umount', tools);

    expect(run).toHaveBeenCalledWith(tools.setfacl, [
      '--remove', 'user:23001', '/dev/kvm',
    ]);
    expect(run).toHaveBeenCalledWith(tools.userdel, [account]);
    expect(run).toHaveBeenCalledWith(tools.groupdel, [account]);
    await expect(fs.access(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires root and refuses to replace an existing run record', async () => {
    const paths = runPaths('exclusive-record');
    const plan = networkPlan(paths.runId);
    await expect(new DurableCloudHypervisorCleanupRegistry(
      dependencies({ effectiveUid: 1000 }),
    ).create(paths, plan, process.execPath, '/usr/bin/ip')).rejects.toThrow(
      /requires effective uid 0/,
    );

    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
    await expect(registry.create(paths, plan, process.execPath, '/usr/bin/ip')).rejects.toThrow(
      /Cleanup record already exists/,
    );
  });

  it('preserves the publication error when temporary-file cleanup also races', async () => {
    const paths = runPaths('publication-failure');
    const link = jest.fn(async () => {
      throw Object.assign(new Error('filesystem denied link'), { code: 'EPERM' });
    }) as typeof fs.link;
    const unlink = jest.fn(async () => {
      throw Object.assign(new Error('temporary file already gone'), { code: 'ENOENT' });
    }) as typeof fs.unlink;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ link, unlink }));

    await expect(registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    )).rejects.toThrow(/filesystem denied link/);
    expect((await fs.readdir(path.join(temporaryRoot, 'pending-cleanup')))).toHaveLength(1);
  });

  it('validates process registration and completes idempotently', async () => {
    const paths = runPaths('process-registration');
    const handle = await new DurableCloudHypervisorCleanupRegistry(dependencies()).create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );

    await expect(handle.prepareProcess('__proto__', process.execPath, '/sock')).rejects.toThrow(
      /Unsafe cleanup process key/,
    );
    await expect(handle.captureProcess('missing', 5000)).rejects.toThrow(
      /identity was not prepared/,
    );
    await handle.complete();
    await expect(handle.complete()).resolves.toBeUndefined();
  });

  it('times out instead of committing a process whose executable never matches', async () => {
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2_001);
    try {
      const paths = runPaths('process-mismatch');
      const handle = await new DurableCloudHypervisorCleanupRegistry(dependencies()).create(
        paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      daemonExecutableLink = '/usr/bin/not-the-prepared-binary';

      await expect(handle.captureProcess('worker', 5000)).rejects.toThrow(
        /did not match its prepared cleanup identity/,
      );
    } finally {
      now.mockRestore();
    }
  });

  it('waits for the trusted exec chain to settle before committing process identity', async () => {
    const paths = runPaths('process-settles');
    const sleep = jest.fn(async () => {
      daemonExecutableLink = process.execPath;
    });
    const handle = await new DurableCloudHypervisorCleanupRegistry(
      dependencies({ sleep }),
    ).create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    await handle.prepareProcess('worker', process.execPath, '/sock');
    daemonExecutableLink = '/usr/bin/setpriv';

    await expect(handle.captureProcess('worker', 5000)).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalled();
  });

  it('retains a stale record when a prepared process identity was never committed', async () => {
    const paths = runPaths('pending-process');
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.prepareProcess('worker', process.execPath, '/sock');
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /launch identity was never committed/,
    );
    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
    )).resolves.toBeUndefined();
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

  it('keeps a live owner active when its executable pathname was atomically replaced', async () => {
    const deps = dependencies();
    const registry = new DurableCloudHypervisorCleanupRegistry(deps);
    const paths = runPaths('upgraded-owner');
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    ownerExecutableLink = `${process.execPath} (deleted)`;

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', 'upgraded-owner.json'),
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
    const paths = runPaths('stale-claim');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', 'stale-claim.json');
    const claimedPath = `${recordPath}.lock-claimed-owner`;
    const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
      if (String(filePath) === claimedPath) {
        await fs.unlink(filePath);
        throw Object.assign(new Error('claim already released'), { code: 'ENOENT' });
      }
      return fs.unlink(filePath);
    }) as typeof fs.unlink;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ unlink }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
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
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === '/usr/bin/umount') {
        mountInfo = mountInfo
          .split('\n')
          .filter((line) => line && !line.includes(` ${args[0]} `))
          .join('\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'Device does not exist' };
    });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ run }));
    const paths = runPaths('mounted-run');
    const mountPoint = path.join(paths.virtiofsdShareDirectory, '0-workspace');
    const nestedMountPoint = path.join(mountPoint, 'nested');
    await fs.mkdir(nestedMountPoint, { recursive: true });
    mountInfo = [
      `123 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw`,
      `124 123 8:1 /source/nested ${nestedMountPoint} rw - ext4 /dev/sda1 rw`,
      '',
    ].join('\n');
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureVirtiofsdResources();
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    expect(run.mock.calls.filter(([command]) => command === '/usr/bin/umount')).toEqual([
      ['/usr/bin/umount', [nestedMountPoint]],
      ['/usr/bin/umount', [mountPoint]],
    ]);
    await expect(fs.access(paths.virtiofsdShareDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('captures and identity-validates every live resource during stale-run recovery', async () => {
    const paths = runPaths('full-recovery');
    const plan = networkPlan(paths.runId);
    const netnsIdentityFile = path.join(temporaryRoot, 'netns-identity');
    await fs.writeFile(netnsIdentityFile, '');
    await fs.mkdir(paths.runDirectory, { recursive: true });
    await fs.mkdir(paths.cgroupPath, { recursive: true });
    await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
    const netnsStat = await fs.lstat(netnsIdentityFile, { bigint: true });
    daemonNamespace = `net:[${netnsStat.ino}]`;
    let netnsExists = true;
    let firewallRuleExists = true;
    const interfaces = new Map([
      [plan.hostVethName, 101],
      [plan.namespaceVethName, 102],
      [plan.tapName, 103],
    ]);
    const base = dependencies();
    const baseLstat = base.lstat as typeof fs.lstat;
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      if (String(filePath) === plan.netnsPath) {
        if (!netnsExists) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return fs.lstat(netnsIdentityFile, options as never);
      }
      return baseLstat(filePath, options as never);
    }) as typeof fs.lstat;
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === '/usr/bin/ip' && args.includes('-json')) {
        const name = args[args.length - 1];
        const ifindex = interfaces.get(name);
        return ifindex === undefined
          ? { exitCode: 1, stdout: '', stderr: 'Device does not exist' }
          : { exitCode: 0, stdout: JSON.stringify([{ ifname: name, ifindex }]), stderr: '' };
      }
      if (command === '/usr/bin/ip' && args[0] === 'link' && args[1] === 'delete') {
        interfaces.delete(args[2]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === '/usr/bin/ip' && args[0] === 'netns' && args[1] === 'delete') {
        netnsExists = false;
        interfaces.delete(plan.namespaceVethName);
        interfaces.delete(plan.tapName);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === 'iptables' && args.includes('-C')) {
        return { exitCode: firewallRuleExists ? 0 : 1, stdout: '', stderr: '' };
      }
      if (command === 'iptables' && args.includes('-D')) {
        firewallRuleExists = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') daemonAlive = false;
      return true as const;
    });
    const registry = new DurableCloudHypervisorCleanupRegistry(
      dependencies({ lstat, run, kill }),
    );
    const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
    await handle.captureNetworkResource('netns');
    await handle.captureNetworkResource('hostVeth');
    await handle.captureNetworkResource('namespaceVeth');
    await handle.captureNetworkResource('tap');
    await handle.captureRunDirectory();
    await handle.captureCgroup();
    await handle.captureVirtiofsdResources();
    await handle.prepareProcess('vmm', process.execPath, '/sock');
    await handle.captureProcess('vmm', 5000);
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    expect(kill).toHaveBeenCalledWith(5000, 'SIGTERM');
    expect(netnsExists).toBe(false);
    expect(interfaces.size).toBe(0);
    expect(firewallRuleExists).toBe(false);
    await expect(fs.access(paths.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(paths.cgroupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(paths.virtiofsdShareDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(
      path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('escalates an identity-validated live process to SIGKILL', async () => {
    const paths = runPaths('kill-escalation');
    const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') daemonAlive = false;
      return true as const;
    });
    const now = jest.spyOn(Date, 'now');
    let currentTime = 0;
    now.mockImplementation(() => {
      currentTime += 1_000;
      return currentTime;
    });
    try {
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ kill }));
      const handle = await registry.create(
        paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      await handle.captureProcess('worker', 5000);
      ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      expect(kill).toHaveBeenNthCalledWith(1, 5000, 'SIGTERM');
      expect(kill).toHaveBeenNthCalledWith(2, 5000, 'SIGKILL');
    } finally {
      now.mockRestore();
    }
  });

  it('retains evidence when bridge-rule revalidation is uncertain', async () => {
    const paths = runPaths('iptables-uncertain');
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({
      run: jest.fn(async (command: string) => (
        command === 'iptables'
          ? { exitCode: 2, stdout: '', stderr: 'xtables lock busy' }
          : { exitCode: 1, stdout: '', stderr: 'Device does not exist' }
      )),
    }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /Could not revalidate per-run bridge rule: xtables lock busy/,
    );
  });

  it('retains evidence when an identity-validated network deletion command fails', async () => {
    const paths = runPaths('network-delete-failure');
    const plan = networkPlan(paths.runId);
    const run = jest.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes('-json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ ifname: plan.hostVethName, ifindex: 41 }]),
          stderr: '',
        };
      }
      if (args[0] === 'link' && args[1] === 'delete') {
        return { exitCode: 2, stdout: '', stderr: 'device busy' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ run }));
    const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
    await handle.captureNetworkResource('hostVeth');
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /link delete.*failed with code 2: device busy/,
    );
  });

  it('does not kill a PID whose committed command arguments no longer match', async () => {
    const paths = runPaths('changed-process-args');
    const deps = dependencies();
    const registry = new DurableCloudHypervisorCleanupRegistry(deps);
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.prepareProcess('worker', process.execPath, '/sock', '/source');
    await handle.captureProcess('worker', 5000);
    daemonCmdline = `${process.execPath}\0--socket-path=/different\0`;
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    expect(deps.kill).not.toHaveBeenCalled();
  });

  it('fails visibly when an identity-validated process survives SIGKILL', async () => {
    const paths = runPaths('unkillable-process');
    const kill = jest.fn(() => true as const);
    const now = jest.spyOn(Date, 'now');
    let currentTime = 0;
    now.mockImplementation(() => {
      currentTime += 1_000;
      return currentTime;
    });
    try {
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ kill }));
      const handle = await registry.create(
        paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      await handle.captureProcess('worker', 5000);
      ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /identity-validated process 5000 did not exit/,
      );
      expect(kill).toHaveBeenCalledWith(5000, 'SIGKILL');
    } finally {
      now.mockRestore();
    }
  });

  it('accepts an ESRCH race only after the recorded process disappears', async () => {
    const paths = runPaths('esrch-exited');
    const kill = jest.fn(() => {
      daemonAlive = false;
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ kill }));
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.prepareProcess('worker', process.execPath, '/sock');
    await handle.captureProcess('worker', 5000);
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).resolves.toBeUndefined();
  });

  it('rejects ESRCH and other kill errors while process identity still matches', async () => {
    for (const [runId, code, expected] of [
      ['esrch-live', 'ESRCH', /still matches after kill reported ESRCH/],
      ['kill-denied', 'EPERM', /operation denied/],
    ] as const) {
      const kill = jest.fn(() => {
        throw Object.assign(new Error('operation denied'), { code });
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ kill }));
      const paths = runPaths(runId);
      const handle = await registry.create(
        paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      await handle.captureProcess('worker', 5000);
      ownerStartTime = '2000';
      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(expected);
      ownerStartTime = '1000';
    }
  });

  it('accepts an ESRCH race after SIGTERM timeout only when SIGKILL sees process exit', async () => {
    const paths = runPaths('sigkill-esrch');
    const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') {
        daemonAlive = false;
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      return true as const;
    });
    const now = jest.spyOn(Date, 'now');
    let currentTime = 0;
    now.mockImplementation(() => {
      currentTime += 1_000;
      return currentTime;
    });
    try {
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ kill }));
      const handle = await registry.create(
        paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      await handle.captureProcess('worker', 5000);
      ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith(5000, 'SIGKILL');
    } finally {
      now.mockRestore();
    }
  });

  it('rejects SIGKILL ESRCH while the recorded process still matches', async () => {
    const paths = runPaths('sigkill-esrch-live');
    const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true as const;
    });
    const now = jest.spyOn(Date, 'now');
    let currentTime = 0;
    now.mockImplementation(() => {
      currentTime += 1_000;
      return currentTime;
    });
    try {
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ kill }));
      const handle = await registry.create(
        paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      await handle.captureProcess('worker', 5000);
      ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /still matches after kill reported ESRCH/,
      );
    } finally {
      now.mockRestore();
    }
  });

  it('retains evidence when a recorded mount identity changes', async () => {
    const paths = runPaths('changed-mount');
    const mountPoint = path.join(paths.virtiofsdShareDirectory, 'workspace');
    await fs.mkdir(mountPoint, { recursive: true });
    mountInfo = `123 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw\n`;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureVirtiofsdResources();
    mountInfo = `124 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw\n`;
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /mount identity changed/,
    );
  });

  it('abandons takeover if the existing claim lock inode changes', async () => {
    const paths = runPaths('claim-inode-race');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
    const lockPath = `${recordPath}.lock`;
    const base = dependencies();
    const baseLstat = base.lstat as typeof fs.lstat;
    let lockStats = 0;
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      const value = await baseLstat(filePath, options as never);
      if (
        String(filePath) === lockPath &&
        (options as { bigint?: boolean } | undefined)?.bigint &&
        ++lockStats === 2
      ) {
        return Object.assign(value, { ino: BigInt(value.ino) + 1n });
      }
      return value;
    }) as typeof fs.lstat;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ lstat }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { owner: unknown };
    await fs.writeFile(lockPath, JSON.stringify(record.owner), { mode: 0o600 });
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    await expect(fs.access(recordPath)).resolves.toBeUndefined();
  });

  it('fails closed on a corrupted renamed cleanup claim', async () => {
    const paths = runPaths('corrupt-renamed-claim');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    await fs.writeFile(`${recordPath}.lock-claimed-corrupt`, '{', { mode: 0o600 });
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /cleanup claim is unreadable/,
    );
  });

  it('surfaces failure to release a newly acquired cleanup claim', async () => {
    const paths = runPaths('claim-release-failure');
    const lockPath = path.join(
      temporaryRoot,
      'pending-cleanup',
      `${paths.runId}.json.lock`,
    );
    const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
      if (String(filePath) === lockPath) {
        throw Object.assign(new Error('claim release denied'), { code: 'EPERM' });
      }
      return fs.unlink(filePath);
    }) as typeof fs.unlink;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ unlink }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /claim release denied/,
    );
  });

  it('surfaces failure to discard a stale renamed cleanup claim', async () => {
    const paths = runPaths('stale-renamed-release');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
    const claimPath = `${recordPath}.lock-claimed-stale`;
    const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
      if (String(filePath) === claimPath) {
        throw Object.assign(new Error('stale claim removal denied'), { code: 'EPERM' });
      }
      return fs.unlink(filePath);
    }) as typeof fs.unlink;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ unlink }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
      owner: Record<string, unknown>;
    };
    await fs.writeFile(claimPath, JSON.stringify({
      ...record.owner,
      pid: 9999,
      startTime: '9999',
    }), { mode: 0o600 });
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /stale claim removal denied/,
    );
  });

  it('refuses recursive deletion when an unrecorded mount appears', async () => {
    const paths = runPaths('late-mount');
    await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureVirtiofsdResources();
    mountInfo = `123 1 8:1 / ${paths.virtiofsdShareDirectory} rw - ext4 /dev/sda1 rw\n`;
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /refusing recursive removal while mounts remain/,
    );
  });

  it('fails when the kernel does not release a cgroup before the retry deadline', async () => {
    const paths = runPaths('cgroup-timeout');
    await fs.mkdir(paths.cgroupPath, { recursive: true });
    const rmdir = jest.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }) as typeof fs.rmdir;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ rmdir }));
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureCgroup();
    ownerStartTime = '2000';
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(6_000);
    try {
      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow('busy');
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ['non-array output', '{}', /Unexpected interface inspection/],
    ['wrong interface', '[{"ifname":"other","ifindex":12}]', /Invalid interface inspection/],
    ['non-integer index', '[{"ifname":"host","ifindex":"12"}]', /Invalid interface inspection/],
  ])('rejects %s from kernel interface inspection', async (_label, stdout, expected) => {
    const paths = runPaths('bad-interface');
    const plan = networkPlan(paths.runId);
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({
      run: jest.fn(async () => ({ exitCode: 0, stdout, stderr: '' })),
    }));
    const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');

    await expect(handle.captureNetworkResource('hostVeth')).rejects.toThrow(expected);
  });

  it('propagates kernel interface inspection failures', async () => {
    const paths = runPaths('interface-inspection-error');
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({
      run: jest.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'netlink denied' })),
    }));
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );

    await expect(handle.captureNetworkResource('hostVeth')).rejects.toThrow(/netlink denied/);
  });

  it('fails closed when process or resource identity cannot be read', async () => {
    const paths = runPaths('identity-unreadable');
    const plan = networkPlan(paths.runId);
    const base = dependencies();
    const baseReadFile = base.readFile as typeof fs.readFile;
    const readFile: typeof fs.readFile = (async (filePath: PathLike, options?: unknown) => {
      if (String(filePath) === '/proc/4242/stat' && ownerStartTime === '2000') {
        throw Object.assign(new Error('proc denied'), { code: 'EACCES' });
      }
      return baseReadFile(filePath, options as never);
    }) as typeof fs.readFile;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ readFile }));
    await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
    ownerStartTime = '2000';
    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /proc denied/,
    );

    ownerStartTime = '1000';
    const secondPaths = runPaths('resource-unreadable');
    const resourcePlan = networkPlan(secondPaths.runId);
    const inaccessibleLstat: typeof fs.lstat = (async (
      filePath: PathLike,
      options?: unknown,
    ) => {
      if (String(filePath) === resourcePlan.netnsPath) {
        throw Object.assign(new Error('netns denied'), { code: 'EACCES' });
      }
      return (base.lstat as typeof fs.lstat)(filePath, options as never);
    }) as typeof fs.lstat;
    const second = new DurableCloudHypervisorCleanupRegistry(
      dependencies({ lstat: inaccessibleLstat }),
    );
    await second.create(
      secondPaths, resourcePlan, process.execPath, '/usr/bin/ip',
    );
    ownerStartTime = '2000';
    await expect(second.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /netns denied/,
    );
  });

  it('rejects malformed mountinfo and decodes valid escaped mount paths', async () => {
    const basePaths = runPaths('mount-parser');
    const paths = {
      ...basePaths,
      virtiofsdShareDirectory: path.join(temporaryRoot, 'virtiofsd with space', basePaths.runId),
    };
    await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    mountInfo = 'not mountinfo\n';
    await expect(handle.captureVirtiofsdResources()).rejects.toThrow(
      /Malformed \/proc\/self\/mountinfo entry/,
    );

    const escaped = paths.virtiofsdShareDirectory.replace(/ /g, '\\040');
    mountInfo = `123 1 8:1 /source ${escaped} rw - ext4 /dev/sda1 rw\n`;
    await expect(handle.captureVirtiofsdResources()).resolves.toBeUndefined();
  });

  it('rejects unsafe registry and record permissions', async () => {
    const unsafeRoot = path.join(temporaryRoot, 'unsafe');
    const unsafeRegistry = path.join(unsafeRoot, 'pending-cleanup');
    await fs.mkdir(unsafeRegistry, { recursive: true, mode: 0o755 });
    await expect(new DurableCloudHypervisorCleanupRegistry(
      dependencies({ rootDirectory: unsafeRoot }),
    ).reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /unsafe ownership or mode/,
    );

    const paths = runPaths('unsafe-record');
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    await fs.chmod(path.join(temporaryRoot, 'pending-cleanup', 'unsafe-record.json'), 0o644);
    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /not a root-owned mode-0600 regular file/,
    );
  });

  it('honors active renamed claims and removes stale renamed claims', async () => {
    const paths = runPaths('renamed-claim');
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', 'renamed-claim.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
      owner: Record<string, unknown>;
    };
    const claimPath = `${recordPath}.lock-claimed-active`;
    await fs.writeFile(claimPath, JSON.stringify({
      ...record.owner,
      pid: 5000,
      startTime: '5000',
      networkNamespace: daemonNamespace,
    }), { mode: 0o600 });
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');
    await expect(fs.access(recordPath)).resolves.toBeUndefined();

    daemonAlive = false;
    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');
    await expect(fs.access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(claimPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsafe or unreadable cleanup claims', async () => {
    for (const [runId, contents, mode, expected] of [
      ['unsafe-claim', '{}', 0o644, /claim has unsafe ownership or mode/],
      ['unreadable-claim', '{', 0o600, /claim is unreadable/],
    ] as const) {
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
      const paths = runPaths(runId);
      await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      await fs.writeFile(
        path.join(temporaryRoot, 'pending-cleanup', `${runId}.json.lock`),
        contents,
        { mode },
      );
      ownerStartTime = '2000';
      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(expected);
      ownerStartTime = '1000';
    }
  });

  it('leaves a stale record untouched when another reaper wins the takeover marker', async () => {
    const paths = runPaths('claim-takeover-race');
    const link: typeof fs.link = (async (source: PathLike, destination: PathLike) => {
      if (String(destination).endsWith('.lock-claimed-owner')) {
        throw Object.assign(new Error('claimed'), { code: 'EEXIST' });
      }
      return fs.link(source, destination);
    }) as typeof fs.link;
    const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
      if (String(filePath).includes('.lock-claimed-owner.tmp-')) {
        throw Object.assign(new Error('temporary marker gone'), { code: 'ENOENT' });
      }
      return fs.unlink(filePath);
    }) as typeof fs.unlink;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ link, unlink }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { owner: unknown };
    await fs.writeFile(`${recordPath}.lock`, JSON.stringify(record.owner), { mode: 0o600 });
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    await expect(fs.access(recordPath)).resolves.toBeUndefined();
  });

  it('runs identity-validated deletion through the default argv-only executor', async () => {
    const paths = runPaths('default-executor');
    const plan = networkPlan(paths.runId);
    const executable = path.join(temporaryRoot, 'fake-ip.js');
    await fs.writeFile(executable, [
      '#!/bin/sh',
      'for name do :; done',
      'case " $* " in *" -json "*) printf \'[{"ifname":"%s","ifindex":42}]\' "$name";; esac',
      '',
    ].join('\n'), { mode: 0o700 });
    const base = dependencies();
    const registry = new DurableCloudHypervisorCleanupRegistry({
      ...base,
      run: undefined,
    });
    const handle = await registry.create(paths, plan, process.execPath, executable);
    await handle.captureNetworkResource('hostVeth');
    ownerStartTime = '2000';

    await expect(registry.reapPending(executable, '/usr/bin/umount')).rejects.toThrow(
      /stale cleanup is incomplete/,
    );
  });

  it('rejects cross-run setup and unstable process credentials', async () => {
    const paths = runPaths('scoped-run');
    await expect(new DurableCloudHypervisorCleanupRegistry(dependencies()).create(
      paths, networkPlan('different-run'), process.execPath, '/usr/bin/ip',
    )).rejects.toThrow(/resources are not scoped to one run/);

    const unstable = dependencies({
      readFile: (async (filePath: PathLike, options?: unknown) => {
        if (String(filePath) === '/proc/4242/stat') return procStat(4242, ownerStartTime);
        if (String(filePath) === '/proc/4242/status') {
          return 'Uid:\t0\t1\t0\t0\nGid:\t0\t0\t0\t0\n';
        }
        return fs.readFile(filePath, options as never);
      }) as typeof fs.readFile,
    });
    await expect(new DurableCloudHypervisorCleanupRegistry(unstable).create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    )).rejects.toThrow(/Process Uid identities are not stable/);
  });

  it('rejects malformed or cross-run recovery evidence', async () => {
    const cases: Array<[string, (record: Record<string, any>) => void, RegExp]> = [
      ['bad-version', (record) => { record.version = 2; }, /invalid cleanup record identity/],
      ['bad-run-path', (record) => { record.paths.runDirectory = '/tmp/other'; }, /not run-scoped/],
      ['bad-owner', (record) => { record.owner.pid = 1; }, /owner identity is malformed/],
      ['bad-processes', (record) => { record.processes = []; }, /resource identities are malformed/],
      ['bad-process', (record) => {
        record.processes.worker = { state: 'pending', executable: 'relative', socketPath: '/sock' };
      }, /process record is malformed/],
      ['bad-mount', (record) => {
        record.mounts = [{
          mountId: 0,
          device: '8:1',
          root: '/',
          mountPoint: record.paths.virtiofsdShareDirectory,
          filesystemType: 'ext4',
          source: '/dev/sda1',
        }];
      }, /mount identity is malformed/],
    ];

    for (const [runId, mutate, expected] of cases) {
      const registry = new DurableCloudHypervisorCleanupRegistry(dependencies());
      const paths = runPaths(runId);
      await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      await mutateRecord(runId, mutate);
      ownerStartTime = '2000';
      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(expected);
      ownerStartTime = '1000';
    }
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

  it('fails if a cgroup inode changes while kernel accounting drains', async () => {
    const paths = runPaths('changed-cgroup');
    await fs.mkdir(paths.cgroupPath, { recursive: true });
    let cgroupStats = 0;
    const base = dependencies();
    const baseLstat = base.lstat as typeof fs.lstat;
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      const value = await baseLstat(filePath, options as never);
      if (
        String(filePath) === paths.cgroupPath &&
        (options as { bigint?: boolean } | undefined)?.bigint &&
        ++cgroupStats >= 4
      ) {
        return Object.assign(value, { ino: BigInt(value.ino) + 1n });
      }
      return value;
    }) as typeof fs.lstat;
    const rmdir = jest.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }) as typeof fs.rmdir;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ lstat, rmdir }));
    const handle = await registry.create(
      paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
    );
    await handle.captureCgroup();
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /identity changed during cgroup drain/,
    );
  });

  it('fails when an interface is replaced after its identity is committed', async () => {
    const paths = runPaths('changed-interface');
    const plan = networkPlan(paths.runId);
    let ifindex = 41;
    const run = jest.fn(async (_command: string, args: readonly string[]) => (
      args.includes('-json')
        ? {
          exitCode: 0,
          stdout: JSON.stringify([{ ifname: plan.hostVethName, ifindex }]),
          stderr: '',
        }
        : { exitCode: 0, stdout: '', stderr: '' }
    ));
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ run }));
    const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
    await handle.captureNetworkResource('hostVeth');
    ifindex = 42;
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /interface ".*" identity changed/,
    );
  });

  it('backs off when a live renamed claimant appears immediately after lock acquisition', async () => {
    const paths = runPaths('late-renamed-claim');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
    const claim = { owner: undefined as Record<string, unknown> | undefined };
    const link: typeof fs.link = (async (source: PathLike, destination: PathLike) => {
      await fs.link(source, destination);
      if (String(destination) === `${recordPath}.lock` && claim.owner) {
        await fs.writeFile(
          `${recordPath}.lock-claimed-racer`,
          JSON.stringify(claim.owner),
          { mode: 0o600 },
        );
      }
    }) as typeof fs.link;
    const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
      if (String(filePath) === `${recordPath}.lock`) {
        await fs.unlink(filePath);
        throw Object.assign(new Error('lock already removed'), { code: 'ENOENT' });
      }
      return fs.unlink(filePath);
    }) as typeof fs.unlink;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ link, unlink }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
      owner: Record<string, unknown>;
    };
    claim.owner = {
      ...record.owner,
      pid: 5000,
      startTime: '5000',
      networkNamespace: daemonNamespace,
    };
    ownerStartTime = '2000';

    await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

    await expect(fs.access(recordPath)).resolves.toBeUndefined();
    await expect(fs.access(`${recordPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails visibly after a contended claim lock repeatedly vanishes', async () => {
    const paths = runPaths('vanishing-claim');
    const recordPath = path.join(temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
    const link: typeof fs.link = (async (source: PathLike, destination: PathLike) => {
      if (String(destination) === `${recordPath}.lock`) {
        throw Object.assign(new Error('contended'), { code: 'EEXIST' });
      }
      return fs.link(source, destination);
    }) as typeof fs.link;
    const registry = new DurableCloudHypervisorCleanupRegistry(dependencies({ link }));
    await registry.create(paths, networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
    ownerStartTime = '2000';

    await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
      /could not atomically claim stale cleanup record/,
    );
  });
});
