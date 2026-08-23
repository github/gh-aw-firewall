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
const STAGED_ROOT = '/run/awf-shares/run/0-workspace';

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
    captureTool: jest.fn().mockResolvedValue('mount from util-linux 2.39.3 (libmount 2.39.0)'),
    statPath: jest.fn().mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    }),
    realpath: jest.fn(async (filePath: string) => filePath),
    readMountInfo: jest
      .fn()
      .mockResolvedValueOnce(`30 29 0:42 / ${STAGED_ROOT} ro,nosuid,nodev - ext4 /dev/root ro`)
      .mockResolvedValueOnce(`30 29 0:42 / ${STAGED_ROOT} ro,nosuid,nodev - ext4 /dev/root ro`)
      .mockResolvedValue(
        [
          `30 29 0:42 / ${STAGED_ROOT} ro,nosuid,nodev - ext4 /dev/root ro`,
          `31 30 0:43 / ${STAGED_ROOT}/out rw,nosuid,nodev - ext4 /dev/root rw`,
        ].join('\n'),
      ),
    sleep: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function manager(deps: VirtiofsdDependencies, cgroup?: Pick<CloudHypervisorCgroup, 'assign'>) {
  return new VirtiofsdManager(
    '/opt/virtiofsd',
    '/run/awf/run',
    '/run/awf-shares/run',
    { uid: 1000, gid: 1000 },
    cgroup ?? { assign: jest.fn().mockResolvedValue(undefined) },
    { mount: '/usr/bin/mount', umount: '/usr/bin/umount' },
    deps,
  );
}

const enforcement = {
  plans: [
    {
      tag: 'workspace',
      writableOverlays: [
        {
          source: '/host/workspace/out',
          destination: '/host/workspace/out',
          kind: 'directory' as const,
        },
      ],
    },
  ],
};

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

describe('VirtiofsdManager host mount-tree enforcement', () => {
  it('fails closed when a plan names an export that does not exist', async () => {
    const deps = dependencies();
    const started = manager(deps);
    // A renamed or mistyped tag must not silently downgrade an export to
    // unrestricted read-write.
    await expect(
      started.start([workspace, cache], { plans: [{ tag: 'other', writableOverlays: [] }] }),
    ).rejects.toThrow(/unknown export tags: other/);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(deps.runTool).not.toHaveBeenCalled();
  });

  it('leaves unplanned exports on the legacy path when other exports are planned', async () => {
    const deps = dependencies({
      readMountInfo: jest
        .fn()
        .mockResolvedValue(`30 29 0:42 / ${STAGED_ROOT} ro,nosuid,nodev - ext4 /dev/root ro`),
    });
    const started = manager(deps);
    await started.start([workspace, cache], { plans: [{ tag: 'workspace', writableOverlays: [] }] });
    const [, workspaceArgs] = (deps.launch as jest.Mock).mock.calls[0];
    expect(workspaceArgs).toContain('--announce-submounts');
    const [, cacheArgs] = (deps.launch as jest.Mock).mock.calls[1];
    expect(cacheArgs).toEqual([
      '--socket-path=/run/awf/run/virtiofs-1.sock',
      '--shared-dir=/run/awf-shares/run/1-cache',
      '--sandbox=namespace',
      '--seccomp=kill',
      '--cache=auto',
      '--inode-file-handles=never',
    ]);
    expect(cacheArgs).not.toContain('--announce-submounts');
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/mount', [
      '--bind', '/host/cache', '/run/awf-shares/run/1-cache',
    ]);
  });

  it('leaves behaviour untouched when no enforcement is supplied', async () => {
    const deps = dependencies();
    const started = manager(deps);
    await started.start([workspace, cache]);
    expect(deps.captureTool).not.toHaveBeenCalled();
    const [, workspaceArgs] = (deps.launch as jest.Mock).mock.calls[0];
    expect(workspaceArgs).toEqual([
      '--socket-path=/run/awf/run/virtiofs-0.sock',
      '--shared-dir=/host/workspace',
      '--sandbox=namespace',
      '--seccomp=kill',
      '--cache=auto',
      '--inode-file-handles=never',
    ]);
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/mount', [
      '--bind', '/host/cache', '/run/awf-shares/run/1-cache',
    ]);
    expect(deps.runTool).not.toHaveBeenCalledWith(
      '/usr/bin/mount',
      expect.arrayContaining(['--rbind']),
    );
  });

  it('serves a staged tree and announces submounts for a planned export', async () => {
    const deps = dependencies();
    const started = manager(deps);
    const devices = await started.start([workspace], enforcement);
    expect(devices).toHaveLength(1);
    const [binary, args] = (deps.launch as jest.Mock).mock.calls[0];
    expect(binary).toBe('/opt/virtiofsd');
    expect(args).toEqual([
      '--socket-path=/run/awf/run/virtiofs-0.sock',
      `--shared-dir=${STAGED_ROOT}`,
      '--sandbox=namespace',
      '--seccomp=kill',
      '--cache=auto',
      '--inode-file-handles=never',
      '--announce-submounts',
    ]);
    expect((deps.runTool as jest.Mock).mock.calls).toEqual([
      ['/usr/bin/mount', ['--rbind', '/host/workspace', STAGED_ROOT]],
      ['/usr/bin/mount', ['--make-rprivate', STAGED_ROOT]],
      ['/usr/bin/mount', ['-o', 'remount,bind,ro,nosuid,nodev', STAGED_ROOT]],
      ['/usr/bin/mount', ['--bind', '/host/workspace/out', `${STAGED_ROOT}/out`]],
      ['/usr/bin/mount', ['--make-rprivate', `${STAGED_ROOT}/out`]],
      ['/usr/bin/mount', ['-o', 'remount,bind,rw,nosuid,nodev', `${STAGED_ROOT}/out`]],
    ]);
    expect(deps.mkdir).toHaveBeenCalledWith(STAGED_ROOT, { recursive: true, mode: 0o700 });
  });

  it('tears the staged tree down deepest-first on stop', async () => {
    const deps = dependencies();
    const started = manager(deps);
    await started.start([workspace], enforcement);
    (deps.runTool as jest.Mock).mockClear();
    await started.stop();
    expect((deps.runTool as jest.Mock).mock.calls).toEqual([
      ['/usr/bin/umount', [`${STAGED_ROOT}/out`]],
      ['/usr/bin/umount', ['-R', STAGED_ROOT]],
    ]);
    expect(deps.rmdir).toHaveBeenCalledWith(STAGED_ROOT);
  });

  it('unmounts the staged tree when the daemon fails to start', async () => {
    const exited = processMock(300);
    Object.assign(exited, { exitCode: 1 });
    const deps = dependencies({ launch: jest.fn().mockReturnValue(exited) });
    const started = manager(deps);
    await expect(started.start([workspace], enforcement)).rejects.toThrow(
      /exited before socket readiness/,
    );
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/umount', [`${STAGED_ROOT}/out`]);
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/umount', ['-R', STAGED_ROOT]);
  });

  it('keeps a staged tree that could not be unmounted during a failed start', async () => {
    let unmountAttempts = 0;
    const deps = dependencies({
      runTool: jest.fn(async (command: string, args: readonly string[]) => {
        if (command.endsWith('umount')) {
          unmountAttempts += 1;
          // Fails during rollback, during start()'s own cleanup, and once more
          // during the first explicit stop().
          if (unmountAttempts <= 3) throw new Error('busy');
          return;
        }
        if (args[0] === '--make-rprivate') throw new Error('propagation change failed');
      }),
    });
    const started = manager(deps);
    await expect(started.start([workspace], enforcement)).rejects.toThrow(
      /propagation change failed; staged mount cleanup failed: busy/,
    );
    await expect(started.stop()).rejects.toThrow('busy');
    await expect(started.stop()).resolves.toBeUndefined();
    expect(unmountAttempts).toBe(4);
    expect(deps.rmdir).toHaveBeenCalledWith(STAGED_ROOT);
  });

  it('refuses writable overlays for an export that is already read-only', async () => {
    const deps = dependencies();
    const started = manager(deps);
    await expect(
      started.start([cache], {
        plans: [
          {
            tag: 'cache',
            writableOverlays: [
              { source: '/host/cache/out', destination: '/host/cache/out', kind: 'directory' },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/cannot receive writable overlays/);
    expect(deps.launch).not.toHaveBeenCalled();
  });
});
