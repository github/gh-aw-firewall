import {
  buildNvxConstrainedLaunchCommand,
  computeNvxCgroupLimits,
  verifyNvxConfinement,
  type NvxConfinementVerifierDependencies,
} from './confinement';

const PID = 4242;
const LAUNCHER_PID = 4200;
const RUN_ID = 'a'.repeat(32);
const CGROUP = `/sys/fs/cgroup/awf-nvx/${RUN_ID}`;

function procStat(pid: number, startTime: string): string {
  return `${pid} (openvmm) ${['S', ...Array(18).fill('0'), startTime, '0'].join(' ')}`;
}

function status(taskId: number, overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    Pid: String(taskId),
    Tgid: String(PID),
    Uid: '1000 1000 1000 1000',
    Gid: '1001 1001 1001 1001',
    Groups: '',
    CapInh: '0000000000000000',
    CapPrm: '0000000000000000',
    CapEff: '0000000000000000',
    CapBnd: '0000000000000000',
    CapAmb: '0000000000000000',
    NoNewPrivs: '1',
    Seccomp: '2',
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => `${key}:\t${value}`).join('\n');
}

function dependencies(overrides: {
  executable?: string;
  executableIdentityMismatch?: boolean;
  status?: string;
  finalStartTime?: string;
  cgroupPids?: string;
} = {}): NvxConfinementVerifierDependencies {
  let processStatReads = 0;
  const files: Record<string, string> = {
    [`/proc/${PID}/task/${PID}/status`]: overrides.status ?? status(PID),
    [`/proc/${PID}/task/${PID}/stat`]: procStat(PID, '22222'),
    [`/proc/${PID}/cgroup`]: `0::/awf-nvx/${RUN_ID}\n`,
    [`${CGROUP}/cgroup.procs`]:
      overrides.cgroupPids ?? `${LAUNCHER_PID}\n${PID}\n`,
    [`${CGROUP}/memory.max`]: '805306368\n',
    [`${CGROUP}/cpu.max`]: '300000 100000\n',
    [`${CGROUP}/pids.max`]: '256\n',
  };
  return {
    readFile: jest.fn(async (filePath) => {
      if (filePath === `/proc/${PID}/stat`) {
        processStatReads += 1;
        return procStat(
          PID,
          processStatReads === 1 ? '11111' : overrides.finalStartTime ?? '11111',
        );
      }
      const value = files[filePath];
      if (value === undefined) throw new Error(`unexpected read: ${filePath}`);
      return value;
    }),
    readlink: jest.fn(async (filePath) => {
      if (filePath === `/proc/${PID}/exe`) {
        return overrides.executable ?? '/trusted/openvmm';
      }
      if (filePath === `/proc/${PID}/ns/net`) return 'net:[4026533000]';
      if (filePath === `/proc/${PID}/ns/mnt`) return 'mnt:[4026533001]';
      throw new Error(`unexpected readlink: ${filePath}`);
    }),
    readdir: jest.fn().mockResolvedValue([String(PID)]),
    realpath: jest.fn().mockResolvedValue('/trusted/openvmm'),
    stat: jest.fn(async (filePath) => {
      if (filePath === '/trusted/openvmm') return { dev: 10n, ino: 20n };
      if (filePath === `/proc/${PID}/exe`) {
        return overrides.executableIdentityMismatch
          ? { dev: 10n, ino: 21n }
          : { dev: 10n, ino: 20n };
      }
      return { dev: 0n, ino: 4026533000n };
    }),
  };
}

function verificationOptions() {
  const command = buildNvxConstrainedLaunchCommand({
    tools: {
      ip: '/usr/sbin/ip',
      bwrap: '/usr/bin/bwrap',
      env: '/usr/bin/env',
      setpriv: '/usr/bin/setpriv',
    },
    namespaceName: 'awfnvx-test',
    identity: { uid: 1000, gid: 1001 },
    nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
    runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
    systemReadOnlyPaths: [
      '/usr',
      '/bin',
      '/lib',
      '/lib64',
      '/etc/ssl',
    ],
    openvmmArguments: ['--paused', '--machine', 'microvm'],
  });
  return {
    openvmmPid: PID,
    expectedOpenvmmExecutable: '/trusted/openvmm',
    expectedCgroupPids: [LAUNCHER_PID, PID],
    identity: { uid: 1000, gid: 1001 },
    launchPolicy: command.confinementPolicy,
    networkNamespace: 'awfnvx-test',
    expectedMountNamespaceInode: '4026533001',
    cgroupPath: CGROUP,
    cgroupLimits: {
      memoryMax: '805306368',
      cpuMax: '300000 100000',
      pidsMax: '256',
    },
  };
}

describe('NVX host confinement', () => {
  it('builds a shell-free namespace, filesystem-jail, and privilege-drop chain', () => {
    const result = buildNvxConstrainedLaunchCommand({
      tools: {
        ip: '/usr/sbin/ip',
        bwrap: '/usr/bin/bwrap',
        env: '/usr/bin/env',
        setpriv: '/usr/bin/setpriv',
      },
      namespaceName: 'awfnvx-abc123',
      identity: { uid: 1000, gid: 1001 },
      nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
      systemReadOnlyPaths: [
        '/usr',
        '/bin',
        '/lib',
        '/lib64',
        '/etc/ssl',
      ],
      openvmmArguments: ['--paused', '--machine', 'microvm'],
    });

    expect(result.command).toBe('/usr/sbin/ip');
    expect(result.args.slice(0, 4)).toEqual([
      'netns', 'exec', 'awfnvx-abc123', '/usr/bin/bwrap',
    ]);
    expect(result.args).toEqual(expect.arrayContaining([
      '--unshare-pid',
      '--unshare-ipc',
      '--block-fd', '3',
      '--json-status-fd', '4',
      '--seccomp', '5',
      '--clearenv',
      '--setenv', 'TERM', 'dumb',
      '--setenv', 'HOME', '/nonexistent',
      '--setenv', 'XDG_STATE_HOME', '/run/awf-nvx/state',
      '--dir', '/etc',
      '--dir', '/opt',
      '--dir', '/run',
      '--dev-bind', '/dev/kvm',
      '--ro-bind', `/run/awf-nvx/runs/${RUN_ID}/resolv.conf`, '/etc/resolv.conf',
      '--ro-bind', `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      '--bind', `/run/awf-nvx/runs/${RUN_ID}`,
      '--clear-groups',
      '--no-new-privs',
      '--bounding-set=-all',
      '/usr/bin/env',
      '--ignore-signal=PIPE',
      '--',
      '/opt/awf-nvx/openvmm',
      '--paused',
      '--machine',
      'microvm',
    ]));
    expect(result.args).not.toContain('/dev/net/tun');
    expect(result.args).not.toContain('/bin/sh');
    expect(result.confinementPolicy.supplementaryGroups).toEqual([]);
    expect(result.confinementPolicy.capabilities.effective)
      .toBe('0000000000000000');
  });

  it('rejects broad or caller-controlled filesystem roots', () => {
    expect(() => buildNvxConstrainedLaunchCommand({
      tools: {
        ip: '/usr/sbin/ip',
        bwrap: '/usr/bin/bwrap',
        env: '/usr/bin/env',
        setpriv: '/usr/bin/setpriv',
      },
      namespaceName: 'awfnvx-test',
      identity: { uid: 1000, gid: 1001 },
      nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
      systemReadOnlyPaths: ['/usr', '/home/runner'],
      openvmmArguments: [],
    })).toThrow(/rejects system root/);
  });

  it('rejects caller-controlled artifact and run directory roots', () => {
    const baseOptions = {
      tools: {
        ip: '/usr/sbin/ip',
        bwrap: '/usr/bin/bwrap',
        env: '/usr/bin/env',
        setpriv: '/usr/bin/setpriv',
      },
      namespaceName: 'awfnvx-test',
      identity: { uid: 1000, gid: 1001 },
      systemReadOnlyPaths: ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl'],
      openvmmArguments: [],
    };
    expect(() => buildNvxConstrainedLaunchCommand({
      ...baseOptions,
      nvxRoot: '/',
      runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
    })).toThrow(/per-run path/);
    expect(() => buildNvxConstrainedLaunchCommand({
      ...baseOptions,
      nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      runDirectory: '/tmp/awf-nvx',
    })).toThrow(/per-run path/);
    expect(() => buildNvxConstrainedLaunchCommand({
      ...baseOptions,
      nvxRoot: `/var/lib/awf-nvx/trusted-artifacts/run-${'b'.repeat(32)}`,
      runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
    })).toThrow(/share one run ID/);
  });

  it('computes explicit memory, CPU, and PID limits', () => {
    expect(computeNvxCgroupLimits({
      guestMemoryMib: 512,
      vcpuCount: 2,
      hostPidsMax: 256,
    })).toEqual({
      memoryMax: String(768 * 1024 * 1024),
      cpuMax: '300000 100000',
      pidsMax: '256',
    });
  });

  it('verifies executable, identity, threads, namespaces, and cgroup limits', async () => {
    await expect(verifyNvxConfinement(
      verificationOptions(),
      dependencies(),
    )).resolves.toEqual(expect.objectContaining({
      schemaVersion: 1,
      process: expect.objectContaining({
        pid: PID,
        executable: '/trusted/openvmm',
        threadCount: 1,
      }),
      namespaces: {
        network: 'net:[4026533000]',
        mount: 'mnt:[4026533001]',
      },
      cgroup: expect.objectContaining({
        processIds: [LAUNCHER_PID, PID],
      }),
    }));
  });

  it.each([
    ['executable substitution', {
      executable: '/usr/bin/python3',
      executableIdentityMismatch: true,
    }, /executable/],
    ['supplementary group retention', {
      status: status(PID, { Groups: '27' }),
    }, /supplementary groups/],
    ['missing seccomp', {
      status: status(PID, { Seccomp: '0' }),
    }, /seccomp filter mode 2/],
    ['unexpected cgroup process', {
      cgroupPids: `${LAUNCHER_PID}\n${PID}\n9999\n`,
    }, /cgroup PIDs/],
    ['PID reuse race', { finalStartTime: '33333' }, /identity or thread-set race/],
  ])('fails closed on %s', async (_label, overrides, error) => {
    await expect(verifyNvxConfinement(
      verificationOptions(),
      dependencies(overrides),
    )).rejects.toThrow(error);
  });
});
