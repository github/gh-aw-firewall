import type { ExecaChildProcess } from 'execa';
import { PassThrough } from 'stream';
import type { CloudHypervisorCgroup } from './launcher';
import {
  VirtiofsdManager,
  buildVirtiofsdArgs,
  type VirtiofsdDependencies,
} from './virtiofsd';

const workspace = {
  tag: 'workspace',
  source: '/host/workspace',
  target: '/workspace',
  mode: 'rw' as const,
};
const cache = {
  tag: 'cache',
  source: '/host/cache',
  target: '/host/cache',
  mode: 'ro' as const,
};

function processMock(pid: number): ExecaChildProcess<string> {
  const child = Promise.resolve({ exitCode: 0 }) as unknown as ExecaChildProcess<string>;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(() => {
      Object.assign(child, { exitCode: 0, killed: true });
      return true;
    }),
  });
  return child;
}

function dependencies(
  overrides: Partial<VirtiofsdDependencies> = {},
): VirtiofsdDependencies {
  let pid = 100;
  return {
    launch: jest.fn(() => processMock(pid++)),
    lstat: jest.fn().mockResolvedValue({ isSocket: () => true }),
    chown: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    rmdir: jest.fn().mockResolvedValue(undefined),
    runTool: jest.fn().mockResolvedValue(undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('VirtiofsdManager', () => {
  it('uses explicit sandbox, seccomp, cache, and inode policy', () => {
    expect(buildVirtiofsdArgs(cache, '/run/awf/cache.sock', '/run/awf-ro/cache')).toEqual([
      '--socket-path=/run/awf/cache.sock',
      '--shared-dir=/run/awf-ro/cache',
      '--sandbox=namespace',
      '--seccomp=kill',
      '--cache=auto',
      '--inode-file-handles=never',
    ]);
  });

  it('starts one daemon per export, assigns the shared cgroup, and cleans residue', async () => {
    const deps = dependencies();
    const cgroup = { assign: jest.fn().mockResolvedValue(undefined) } as unknown as CloudHypervisorCgroup;
    const manager = new VirtiofsdManager(
      '/opt/virtiofsd',
      '/run/awf/run',
      '/run/awf-shares/run',
      { uid: 1000, gid: 1000 },
      cgroup,
      { mount: '/usr/bin/mount', umount: '/usr/bin/umount' },
      deps,
    );
    const devices = await manager.start([workspace, cache]);
    expect(devices.map((device) => device.socketPath)).toEqual([
      '/run/awf/run/virtiofs-0.sock',
      '/run/awf/run/virtiofs-1.sock',
    ]);
    expect(deps.launch).toHaveBeenCalledTimes(2);
    expect(deps.launch).toHaveBeenCalledWith(
      '/opt/virtiofsd',
      expect.arrayContaining(['--sandbox=namespace', '--seccomp=kill']),
      {
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        extendEnv: false,
      },
    );
    expect(cgroup.assign).toHaveBeenNthCalledWith(1, 100);
    expect(cgroup.assign).toHaveBeenNthCalledWith(2, 101);
    expect(deps.chown).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', 1000, 1000);
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/mount', [
      '--bind', '/host/cache', '/run/awf-shares/run/1-cache',
    ]);
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/mount', [
      '-o', 'remount,bind,ro,nosuid,nodev', '/run/awf-shares/run/1-cache',
    ]);

    await manager.stop();
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    expect(deps.rm).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', { force: true });
    expect(deps.runTool).toHaveBeenCalledWith(
      '/usr/bin/umount',
      ['/run/awf-shares/run/1-cache'],
    );
  });

  it('fails closed and reaps a partial start when the socket is unavailable', async () => {
    const exited = processMock(200);
    Object.assign(exited, { exitCode: 1 });
    const deps = dependencies({ launch: jest.fn().mockReturnValue(exited) });
    const manager = new VirtiofsdManager(
      '/opt/virtiofsd',
      '/run/awf/run',
      '/run/awf-shares/run',
      { uid: 1000, gid: 1000 },
      { assign: jest.fn().mockResolvedValue(undefined) },
      { mount: '/usr/bin/mount', umount: '/usr/bin/umount' },
      deps,
    );
    await expect(manager.start([workspace])).rejects.toThrow(/exited before socket readiness/);
    expect(deps.rm).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', { force: true });
  });

  it('retains failed bind cleanup so a later stop can retry it', async () => {
    let unmountAttempts = 0;
    const deps = dependencies({
      runTool: jest.fn(async (command: string) => {
        if (command.endsWith('umount') && ++unmountAttempts === 1) {
          throw new Error('busy');
        }
      }),
    });
    const manager = new VirtiofsdManager(
      '/opt/virtiofsd',
      '/run/awf/run',
      '/run/awf-shares/run',
      { uid: 1000, gid: 1000 },
      { assign: jest.fn().mockResolvedValue(undefined) },
      { mount: '/usr/bin/mount', umount: '/usr/bin/umount' },
      deps,
    );
    await manager.start([cache]);

    await expect(manager.stop()).rejects.toThrow('busy');
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(unmountAttempts).toBe(2);
  });
});
