import type { ExecaChildProcess } from 'execa';
import { PassThrough } from 'stream';
import type { CloudHypervisorCgroup } from './launcher';
import {
  VirtiofsdManager,
  buildVirtiofsdArgs,
  type VirtiofsdDependencies,
} from './virtiofsd';
import {
  VIRTIOFSD_ENVIRONMENT,
  captureVirtiofsdProcessIdentity,
} from './virtiofsd-sandbox';

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
  const launches = new Map<number, string[]>();
  const launch = jest.fn((command: string, args: string[]) => {
    const nextPid = pid++;
    launches.set(nextPid, [command, ...args]);
    return processMock(nextPid);
  });
  const readFile = jest.fn(async (filePath: string) => {
    const match = /^\/proc\/(\d+)\//.exec(filePath);
    const processPid = match ? Number(match[1]) : 0;
    const parentPid = processPid >= 1_000 ? processPid - 1_000 : processPid;
    const isWorker = processPid >= 1_000;
    if (filePath.endsWith('/stat')) {
      const fields = Array(20).fill('0');
      fields[19] = String(processPid * 10);
      return `${processPid} (virtiofsd) ${fields.join(' ')}`;
    }
    if (filePath.endsWith('/children')) return String(parentPid + 1_000);
    if (filePath.endsWith('/comm')) return 'virtiofsd\n';
    if (filePath.endsWith('/cmdline')) return `${(launches.get(parentPid) ?? []).join('\0')}\0`;
    if (filePath.endsWith('/status')) {
      const zero = '0000000000000000';
      const reviewed = '00000000880000db';
      return [
        'Uid:\t0\t0\t0\t0',
        'Gid:\t0\t0\t0\t0',
        `CapInh:\t${zero}`,
        `CapPrm:\t${isWorker ? reviewed : zero}`,
        `CapEff:\t${isWorker ? reviewed : zero}`,
        `CapBnd:\t${zero}`,
        `CapAmb:\t${zero}`,
        `NoNewPrivs:\t${isWorker ? 1 : 0}`,
        `Seccomp:\t${isWorker ? 2 : 0}`,
      ].join('\n');
    }
    if (filePath.endsWith('/environ')) {
      return `${Object.entries(VIRTIOFSD_ENVIRONMENT)
        .map(([name, value]) => `${name}=${value}`).join('\0')}\0`;
    }
    if (filePath.endsWith('/cgroup')) return '0::/awf-cloud-hypervisor/test\n';
    throw Object.assign(new Error(`unexpected read: ${filePath}`), { code: 'ENOENT' });
  });
  return {
    launch,
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
    readFile,
    readlink: jest.fn(async (filePath: string) => {
      if (filePath.endsWith('/exe')) return '/opt/virtiofsd';
      if (filePath.startsWith('/proc/self/ns/')) return `${filePath.split('/').pop()}:[1]`;
      return `${filePath.split('/').pop()}:[2]`;
    }),
    statIdentity: jest.fn().mockResolvedValue({ dev: 8, ino: 42 }),
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

function manager(
  deps: VirtiofsdDependencies,
  cgroup?: Pick<CloudHypervisorCgroup, 'assign' | 'cgroupPath'>,
) {
  return new VirtiofsdManager(
    '/opt/virtiofsd',
    '/run/awf/run',
    '/run/awf-shares/run',
    { uid: 1000, gid: 1000 },
    cgroup ?? {
      cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/test',
      assign: jest.fn().mockResolvedValue(undefined),
    },
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
    const cgroup = {
      cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/test',
      assign: jest.fn().mockResolvedValue(undefined),
    } as unknown as CloudHypervisorCgroup;
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
        env: VIRTIOFSD_ENVIRONMENT,
        extendEnv: false,
      },
    );
    expect(cgroup.assign).toHaveBeenNthCalledWith(1, 100);
    expect(cgroup.assign).toHaveBeenNthCalledWith(2, 1100);
    expect(cgroup.assign).toHaveBeenNthCalledWith(3, 101);
    expect(cgroup.assign).toHaveBeenNthCalledWith(4, 1101);
    expect(deps.chown).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', 1000, 1000);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/run/awf/run/virtiofs-0-confinement.json',
      expect.stringContaining('"verified": true'),
      { mode: 0o600 },
    );
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/mount', [
      '--bind', '/host/cache', '/run/awf-shares/run/1-cache',
    ]);
    expect(deps.runTool).toHaveBeenCalledWith('/usr/bin/mount', [
      '-o', 'remount,bind,ro,nosuid,nodev', '/run/awf-shares/run/1-cache',
    ]);
    const launched = (deps.launch as jest.Mock).mock.results[0].value as ExecaChildProcess<string>;
    launched.stdout?.emit('data', 'virtiofsd stdout');
    launched.stderr?.emit('data', 'virtiofsd stderr');

    await manager.stop();
    expect(deps.writeFile).toHaveBeenCalledTimes(4);
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
      {
        cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/test',
        assign: jest.fn().mockResolvedValue(undefined),
      },
      { mount: '/usr/bin/mount', umount: '/usr/bin/umount' },
      deps,
    );
    await expect(manager.start([workspace])).rejects.toThrow(/exited before socket readiness/);
    expect(deps.rm).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', { force: true });
  });

  it('fails closed, records evidence, and withholds the socket when the sandbox is unsafe', async () => {
    const deps = dependencies();
    const readFile = deps.readFile;
    deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
      if (filePath.endsWith('/environ')) return 'PATH=/usr/bin\0SECRET_TOKEN=exposed\0';
      return readFile(filePath, encoding);
    });
    const started = manager(deps);

    await expect(started.start([workspace])).rejects.toThrow(
      /inherited unexpected environment variables/,
    );
    expect(deps.chown).not.toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/run/awf/run/virtiofs-0-confinement.json',
      expect.stringContaining('"verified": false'),
      { mode: 0o600 },
    );
    expect(started.getDiagnosticDevices()).toEqual([
      expect.objectContaining({
        evidencePath: '/run/awf/run/virtiofs-0-confinement.json',
      }),
    ]);
    expect(deps.rm).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', { force: true });
  });

  it('rejects a sandbox worker outside the assigned cgroup', async () => {
    const deps = dependencies();
    const readFile = deps.readFile;
    deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
      if (filePath.endsWith('/cgroup')) return '0::/system.slice\n';
      return readFile(filePath, encoding);
    });

    await expect(manager(deps).start([workspace])).rejects.toThrow(
      /worker is not in its expected cgroup|parent is not in its expected cgroup/,
    );
  });

  it('rejects malformed and unsafe process identities', async () => {
    const deps = dependencies();
    await expect(captureVirtiofsdProcessIdentity(1, deps)).rejects.toThrow(/invalid PID/);

    deps.readFile = jest.fn().mockResolvedValue('100 malformed');
    await expect(captureVirtiofsdProcessIdentity(100, deps)).rejects.toThrow(
      /malformed \/proc stat data/,
    );

    deps.readFile = jest.fn().mockResolvedValue('100 (virtiofsd) S');
    await expect(captureVirtiofsdProcessIdentity(100, deps)).rejects.toThrow(
      /no valid process start time/,
    );
  });

  it.each([
    {
      name: 'parent capabilities',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/100/status'
            ? contents.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000001')
            : contents;
        });
      },
      error: /parent CapEff is not empty/,
    },
    {
      name: 'worker capabilities',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/1100/status'
            ? contents.split('00000000880000db').join('0000000000000000')
            : contents;
        });
      },
      error: /worker capabilities differ/,
    },
    {
      name: 'worker inheritable capabilities',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/1100/status'
            ? contents.replace('CapInh:\t0000000000000000', 'CapInh:\t0000000000000001')
            : contents;
        });
      },
      error: /worker capabilities differ/,
    },
    {
      name: 'worker bounding capabilities',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/1100/status'
            ? contents.replace('CapBnd:\t0000000000000000', 'CapBnd:\t00000000880000db')
            : contents;
        });
      },
      error: /bounding capability set is not empty/,
    },
    {
      name: 'worker NoNewPrivs',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/1100/status'
            ? contents.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0')
            : contents;
        });
      },
      error: /missing NoNewPrivs/,
    },
    {
      name: 'worker uid',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/1100/status'
            ? contents.replace('Uid:\t0\t0\t0\t0', 'Uid:\t1000\t1000\t1000\t1000')
            : contents;
        });
      },
      error: /worker uid\/gid differs/,
    },
    {
      name: 'mount namespace',
      mutate: (deps: VirtiofsdDependencies) => {
        const readlink = deps.readlink;
        deps.readlink = jest.fn(async (filePath: string) => (
          filePath === '/proc/1100/ns/mnt' ? 'mnt:[1]' : readlink(filePath)
        ));
      },
      error: /did not isolate its mnt namespace/,
    },
    {
      name: 'pivoted root',
      mutate: (deps: VirtiofsdDependencies) => {
        deps.statIdentity = jest.fn(async (filePath: string) => (
          filePath === '/proc/1100/root' ? { dev: 8, ino: 43 } : { dev: 8, ino: 42 }
        ));
      },
      error: /root is not its declared export/,
    },
    {
      name: 'trusted executable',
      mutate: (deps: VirtiofsdDependencies) => {
        const readlink = deps.readlink;
        deps.readlink = jest.fn(async (filePath: string) => (
          filePath === '/proc/100/exe' ? '/tmp/substituted' : readlink(filePath)
        ));
      },
      error: /parent executable differs from the trusted binary/,
    },
    {
      name: 'launch arguments',
      mutate: (deps: VirtiofsdDependencies) => {
        const readFile = deps.readFile;
        deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
          const contents = await readFile(filePath, encoding);
          return filePath === '/proc/100/cmdline'
            ? contents.replace('--sandbox=namespace', '--sandbox=none')
            : contents;
        });
      },
      error: /command line does not match/,
    },
  ])('fails closed when $name verification fails', async ({ mutate, error }) => {
    const deps = dependencies();
    mutate(deps);
    await expect(manager(deps).start([workspace])).rejects.toThrow(error);
    expect(deps.chown).not.toHaveBeenCalled();
    expect(deps.rm).toHaveBeenCalledWith('/run/awf/run/virtiofs-0.sock', { force: true });
  });

  it('rejects a cgroup path outside the unified hierarchy', async () => {
    const deps = dependencies();
    const cgroup = {
      cgroupPath: '/tmp/not-a-cgroup',
      assign: jest.fn().mockResolvedValue(undefined),
    };
    await expect(manager(deps, cgroup).start([workspace])).rejects.toThrow(
      /expected cgroup is outside cgroup v2/,
    );
  });

  it('rejects a parent identity that changes during verification', async () => {
    const deps = dependencies();
    const readFile = deps.readFile;
    let parentStatReads = 0;
    deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
      const contents = await readFile(filePath, encoding);
      if (filePath !== '/proc/100/stat' || ++parentStatReads < 3) return contents;
      return contents.replace(/\d+$/, '999999');
    });
    await expect(manager(deps).start([workspace])).rejects.toThrow(
      /parent process identity changed/,
    );
  });

  it('ignores invalid and exited child candidates while discovering the sandbox worker', async () => {
    const deps = dependencies();
    const readFile = deps.readFile;
    deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
      if (filePath.endsWith('/children')) return '0 1 999 1100';
      if (filePath === '/proc/999/comm') {
        throw Object.assign(new Error('exited'), { code: 'ENOENT' });
      }
      return readFile(filePath, encoding);
    });
    await expect(manager(deps).start([workspace])).resolves.toHaveLength(1);
  });

  it('surfaces an unexpected procfs error while discovering the sandbox worker', async () => {
    const deps = dependencies();
    const readFile = deps.readFile;
    deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => {
      if (filePath.endsWith('/children')) return '999';
      if (filePath === '/proc/999/comm') {
        throw Object.assign(new Error('proc denied'), { code: 'EACCES' });
      }
      return readFile(filePath, encoding);
    });
    await expect(manager(deps).start([workspace])).rejects.toThrow(/proc denied/);
  });

  it('fails closed when the sandbox worker does not appear before the deadline', async () => {
    const deps = dependencies();
    const readFile = deps.readFile;
    deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => (
      filePath.endsWith('/children') ? '' : readFile(filePath, encoding)
    ));
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(6_001);
    try {
      await expect(manager(deps).start([workspace])).rejects.toThrow(
        /did not create its sandbox worker/,
      );
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { unsafeSandbox: false, expected: /writing virtiofsd confinement evidence failed/ },
    {
      unsafeSandbox: true,
      expected: /sandbox verification failed: .*writing confinement evidence failed/,
    },
  ])('surfaces evidence write failure (unsafe=$unsafeSandbox)', async ({
    unsafeSandbox,
    expected,
  }) => {
    const deps = dependencies();
    const readFile = deps.readFile;
    if (unsafeSandbox) {
      deps.readFile = jest.fn(async (filePath: string, encoding: BufferEncoding) => (
        filePath.endsWith('/environ')
          ? 'PATH=/usr/bin\0SECRET_TOKEN=exposed\0'
          : readFile(filePath, encoding)
      ));
    }
    const writeFile = deps.writeFile;
    deps.writeFile = jest.fn(async (filePath: string, contents, options) => {
      if (filePath.endsWith('-confinement.json')) throw new Error('disk full');
      return writeFile(filePath, contents, options);
    });
    await expect(manager(deps).start([workspace])).rejects.toThrow(expected);
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
      {
        cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/test',
        assign: jest.fn().mockResolvedValue(undefined),
      },
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
