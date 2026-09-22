import * as path from 'path';
import {
  NvxCgroupManager,
  NvxVmmIdentityManager,
  buildNvxPhase3dLaunchPlan,
  createNvxAccountName,
  createNvxNetworkPlan,
  type NvxRuntimeLifecycleDependencies,
  type NvxRuntimeToolPaths,
} from './runtime-lifecycle';
import type { NvxFilesystemBundle } from './filesystem-builder';
import { runtimeUsesComposeAgent } from '../container-runtime';

const RUN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const tools: NvxRuntimeToolPaths = {
  bwrap: '/usr/bin/bwrap',
  flock: '/usr/bin/flock',
  getfacl: '/usr/bin/getfacl',
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/sbin/ip',
  iptables: '/usr/sbin/iptables',
  nft: '/usr/sbin/nft',
  setfacl: '/usr/bin/setfacl',
  setpriv: '/usr/bin/setpriv',
  sysctl: '/usr/sbin/sysctl',
  useradd: '/usr/sbin/useradd',
  userdel: '/usr/sbin/userdel',
};

function identityDependencies(
  overrides: Partial<NvxRuntimeLifecycleDependencies> = {},
) {
  let accountExists = false;
  let groupExists = false;
  let accountName = '';
  let accountComment = '';
  let accountLockExists = false;
  let deviceLockExists = false;
  const ownerContents = new Map<string, string>();
  const aclPaths = new Set<string>();
  const run = jest.fn(async (command: string, args: readonly string[]) => {
    if (command === tools.useradd) {
      accountExists = true;
      groupExists = true;
      accountComment = args[args.indexOf('--comment') + 1];
      accountName = args[args.length - 1];
      return { stdout: '', stderr: '' };
    }
    if (command === tools.userdel) {
      accountExists = false;
      groupExists = false;
      return { stdout: '', stderr: '' };
    }
    if (command === tools.groupdel) {
      groupExists = false;
      return { stdout: '', stderr: '' };
    }
    if (command === tools.setfacl) {
      if (args[0] === '--modify') aclPaths.add(args[2]);
      if (args[0] === '--remove') aclPaths.delete(args[2]);
      return { stdout: '', stderr: '' };
    }
    if (command === tools.getfacl) {
      const devicePath = args[2];
      return {
        stdout: aclPaths.has(devicePath) ? 'user:23001:rw-\n' : '',
        stderr: '',
      };
    }
    if (command === tools.getent && args[0] === 'group') {
      if (!groupExists) throw new Error('missing group');
      return { stdout: `${accountName}:x:23002:\n`, stderr: '' };
    }
    if (command === tools.getent && args[0] === 'passwd') {
      if (!accountExists) throw new Error('missing account');
      return {
        stdout: `${accountName}:x:23001:23002:${accountComment}:/nonexistent:/usr/sbin/nologin\n`,
        stderr: '',
      };
    }
    if (command === tools.id) {
      if (!accountExists) throw new Error('missing account');
      if (args[0] === '-u') return { stdout: '23001\n', stderr: '' };
      if (args[0] === '-g') return { stdout: '23002\n', stderr: '' };
      return { stdout: '23002\n', stderr: '' };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const deps: NvxRuntimeLifecycleDependencies = {
    mkdir: jest.fn(async (directory) => {
      if (directory.endsWith('.account-lock')) {
        if (accountLockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        accountLockExists = true;
      }
      if (directory.endsWith('.device-acl-lock')) {
        if (deviceLockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        deviceLockExists = true;
      }
    }),
    writeFile: jest.fn(async (filePath, contents) => {
      ownerContents.set(filePath, contents);
    }),
    readFile: jest.fn(async (filePath) => ownerContents.get(filePath) ?? ''),
    rm: jest.fn(async (directory) => {
      if (directory.endsWith('.account-lock')) accountLockExists = false;
      if (directory.endsWith('.device-acl-lock')) deviceLockExists = false;
      for (const filePath of ownerContents.keys()) {
        if (filePath.startsWith(`${directory}/`)) ownerContents.delete(filePath);
      }
    }),
    rename: jest.fn(async (from: string, to: string) => {
      if (from.endsWith('.account-lock')) accountLockExists = false;
      if (from.endsWith('.device-acl-lock')) deviceLockExists = false;
      for (const filePath of [...ownerContents.keys()]) {
        if (filePath.startsWith(`${from}/`)) {
          ownerContents.set(filePath.replace(from, to), ownerContents.get(filePath) as string);
          ownerContents.delete(filePath);
        }
      }
    }),
    rmdir: jest.fn().mockResolvedValue(undefined),
    lstat: jest.fn(async (filePath) => ({
      uid: 0,
      gid: 0,
      dev: 5,
      ino: filePath === '/dev/kvm' ? 10 : 11,
      mtimeMs: 0,
    })),
    run,
    sleep: jest.fn().mockResolvedValue(undefined),
    pid: 123,
    processStartTime: jest.fn().mockResolvedValue('99'),
    ...overrides,
  };
  return { deps, run };
}

function filesystemBundle(): NvxFilesystemBundle {
  const runDirectory = `/run/awf-nvx/runs/${RUN_ID}`;
  return {
    runDirectory,
    manifestPath: path.join(runDirectory, 'manifest.json'),
    sourceDateEpoch: 0,
    layers: [{
      role: 'distro',
      path: path.join(runDirectory, 'distro.erofs'),
      uuid: '11111111-1111-4111-8111-111111111111',
      sha256: '1'.repeat(64),
      sourceManifestSha256: '2'.repeat(64),
      sourceEntries: 1,
      excludedPaths: [],
    }],
    scratch: {
      path: path.join(runDirectory, 'scratch.ext4'),
      uuid: '22222222-2222-4222-8222-222222222222',
      sizeBytes: 128 * 1024 * 1024,
      uid: 65534,
      gid: 65534,
    },
  };
}

describe('NVX Phase 3d runtime lifecycle', () => {
  it('creates a run-bound no-login account and grants only the KVM device ACL', async () => {
    const { deps, run } = identityDependencies();
    const observer = {
      prepareAccount: jest.fn().mockResolvedValue(undefined),
      captureIdentity: jest.fn().mockResolvedValue(undefined),
      prepareDeviceAcl: jest.fn().mockResolvedValue(undefined),
      releaseDeviceAcl: jest.fn().mockResolvedValue(undefined),
    };
    const manager = new NvxVmmIdentityManager(RUN_ID, tools, deps, observer);

    const identity = await manager.allocate();
    expect(identity).toEqual({
      name: expect.stringMatching(/^awfnvx-a1b2c3d4e5[a-f0-9]{10}$/),
      uid: 23001,
      gid: 23002,
    });
    expect(run).toHaveBeenCalledWith(tools.useradd, expect.arrayContaining([
      '--system',
      '--user-group',
      '--no-create-home',
      '--home-dir', '/nonexistent',
      '--shell', '/usr/sbin/nologin',
      '--comment',
      `AWF NVX ${RUN_ID}`,
    ]));
    expect(observer.captureIdentity).toHaveBeenCalledWith(identity);

    const protectedOperation = jest.fn().mockResolvedValue('launched');
    await expect(manager.withDeviceAccess(protectedOperation)).resolves.toBe('launched');
    expect(protectedOperation).toHaveBeenCalledWith([
      { path: '/dev/kvm', device: '5', inode: '10', uid: 23001, permissions: 'rw-' },
    ]);
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/kvm'],
    );
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--remove', 'user:23001', '/dev/kvm'],
    );
    expect(run).not.toHaveBeenCalledWith(
      tools.setfacl,
      expect.arrayContaining(['/dev/net/tun']),
    );

    await manager.cleanup();
    expect(run).toHaveBeenCalledWith(tools.userdel, [identity.name]);
    expect(run).not.toHaveBeenCalledWith(tools.groupdel, [identity.name]);
  });

  it('rejects supplementary groups and unsafe passwd state before launch', async () => {
    const base = identityDependencies();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      const result = await originalRun(command, args);
      if (command === tools.id && args[0] === '-G') return { stdout: '23002 27\n', stderr: '' };
      return result;
    });
    await expect(new NvxVmmIdentityManager(RUN_ID, tools, base.deps).allocate())
      .rejects.toThrow(/supplementary groups/);
    expect(base.deps.run).toHaveBeenCalledWith(
      tools.userdel,
      [expect.stringMatching(/^awfnvx-/)],
    );
  });

  it('revokes a partially granted device ACL when grant validation fails', async () => {
    const { deps, run } = identityDependencies();
    const originalRun = deps.run;
    deps.run = jest.fn(async (command, args) => {
      const result = await originalRun(command, args);
      // The ACL lands with unexpected permissions, so grant validation fails
      // after `setfacl` already changed the device.
      if (command === tools.getfacl && args[2] === '/dev/kvm') {
        return { stdout: result.stdout.replace('rw-', 'r--'), stderr: '' };
      }
      return result;
    });
    const manager = new NvxVmmIdentityManager(RUN_ID, tools, deps);
    await manager.allocate();

    await expect(manager.withDeviceAccess(jest.fn()))
      .rejects.toThrow(/ACL validation failed/);
    expect(deps.run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/kvm'],
    );
    expect(deps.run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--remove', 'user:23001', '/dev/kvm'],
    );
    expect(run).not.toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/net/tun'],
    );
    await expect(manager.cleanup()).resolves.toBeUndefined();
  });

  it('reclaims a stale lifecycle lock through an atomic quarantine rename', async () => {
    const { deps } = identityDependencies();
    let lockExists = true;
    const removed: string[] = [];
    deps.mkdir = jest.fn(async (directory: string) => {
      if (directory.endsWith('.account-lock')) {
        if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        lockExists = true;
      }
    }) as NvxRuntimeLifecycleDependencies['mkdir'];
    deps.rename = jest.fn(async (from: string) => {
      if (!lockExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      lockExists = false;
      expect(from).toContain('.account-lock');
    });
    deps.rm = jest.fn(async (target: string) => {
      removed.push(target);
      if (target.endsWith('.account-lock')) lockExists = false;
    });
    // The recorded owner PID is not running, so the lock is stale.
    deps.processStartTime = jest.fn(async (pid: number) => (pid === 123 ? '99' : undefined));
    deps.readFile = jest.fn(async () => JSON.stringify({ pid: 999, startTime: '7' }));

    await expect(new NvxVmmIdentityManager(RUN_ID, tools, deps).allocate())
      .rejects.toThrow(/lock ownership changed unexpectedly/);
    expect(deps.rename).toHaveBeenCalledWith(
      expect.stringContaining('.account-lock'),
      expect.stringMatching(/\.account-lock\.stale-[a-f0-9]{32}$/),
    );
    expect(removed.some((target) => /\.stale-[a-f0-9]{32}$/.test(target))).toBe(true);
  });

  it('restores a quarantined lock whose owner is still live', async () => {
    const { deps } = identityDependencies();
    deps.mkdir = jest.fn(async (directory: string) => {
      if (directory.endsWith('.account-lock')) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
    }) as NvxRuntimeLifecycleDependencies['mkdir'];
    deps.rename = jest.fn().mockResolvedValue(undefined);
    deps.rm = jest.fn().mockResolvedValue(undefined);
    let reads = 0;
    deps.readFile = jest.fn(async () => {
      // The quarantined directory turns out to hold a different, live owner.
      reads += 1;
      return JSON.stringify(reads === 1
        ? { pid: 999, startTime: '7' }
        : { pid: 321, startTime: '42' });
    });
    deps.processStartTime = jest.fn(async (pid: number) => {
      if (pid === 123) return '99';
      if (pid === 321) return '42';
      return undefined;
    });

    await expect(new NvxVmmIdentityManager(RUN_ID, tools, deps).allocate())
      .rejects.toThrow(/raced with another lock owner/);
    expect(deps.rename).toHaveBeenCalledTimes(2);
    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('applies and verifies cgroup v2 CPU, memory, PID limits and exact membership', async () => {
    const files = new Map<string, string>();
    const members = new Set<number>();
    const deps = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn(async (filePath: string, contents: string) => {
        if (filePath.endsWith('/cgroup.procs')) members.add(Number(contents));
        else files.set(filePath, contents);
      }),
      readFile: jest.fn(async (filePath: string) => {
        if (filePath.endsWith('/cgroup.procs')) {
          return [...members].sort((a, b) => a - b).join('\n') + '\n';
        }
        return files.get(filePath) ?? '';
      }),
      rmdir: jest.fn().mockResolvedValue(undefined),
    };
    const cgroupPath = `/sys/fs/cgroup/awf-nvx/${RUN_ID}`;
    const manager = new NvxCgroupManager(cgroupPath, {
      memoryMax: '805306368',
      cpuMax: '300000 100000',
      pidsMax: '256',
    }, deps);

    await manager.setup();
    expect(deps.writeFile).toHaveBeenCalledWith('/sys/fs/cgroup/cgroup.subtree_control', '+cpu +memory +pids');
    expect(deps.writeFile).toHaveBeenCalledWith(`${cgroupPath}/memory.max`, '805306368');

    await manager.assignProcessTree([4002, 4001, 4001]);
    await expect(manager.cleanup()).rejects.toThrow(/non-empty NVX cgroup/);
    members.clear();
    await expect(manager.cleanup()).resolves.toBeUndefined();
    expect(deps.rmdir).toHaveBeenCalledWith(cgroupPath);
  });

  it('builds a constrained one-shot launch plan under one canonical run ID', () => {
    const plan = buildNvxPhase3dLaunchPlan({
      runId: RUN_ID,
      tools,
      identity: { name: `awfnvx-${RUN_ID.slice(0, 20)}`, uid: 23001, gid: 23002 },
      filesystem: filesystemBundle(),
      execution: {
        entrypoint: '/bin/true',
        args: ['--version'],
        memoryMib: 512,
        pidsMax: 256,
      },
      network: {
        infrastructureBridge: 'br-awf',
        enableApiProxy: true,
        controlPeers: [{ ip: '172.30.0.40', ports: [8080] }],
      },
    });

    expect(plan.layout).toEqual(expect.objectContaining({
      runId: RUN_ID,
      networkNamespace: `awfnvx-${RUN_ID}`,
    }));
    expect(plan.networkPlan.namespaceName).toBe(`awfnvx-${RUN_ID}`);
    expect(plan.networkRuleset).toContain('policy drop');
    expect(plan.networkRuleset).toContain('udp dport 53 counter drop');
    expect(plan.networkRuleset).toContain('ip daddr 169.254.0.0/16 counter drop');
    expect(plan.networkRuleset).toContain('ip daddr 172.30.0.40 tcp dport 8080');
    expect(plan.launchCommand.command).toBe(tools.ip);
    expect(plan.launchCommand.args.slice(0, 4)).toEqual([
      'netns', 'exec', `awfnvx-${RUN_ID}`, tools.bwrap,
    ]);
    expect(plan.networkPlan.tapEnabled).toBe(false);
    expect(plan.launchCommand.args).toEqual(expect.arrayContaining([
      '--block-fd',
      '3',
      '--json-status-fd',
      '4',
      '--seccomp',
      '5',
      '--clearenv',
      '--setenv',
      'TERM',
      'dumb',
      '--clear-groups',
      '--no-new-privs',
      '/opt/awf-nvx/openvmm',
      '--machine',
      'microvm',
      '--paused',
      '--microvm-lifecycle',
      'one-shot',
      '--single-process',
      '--hypervisor',
      'kvm',
      '--network-egress',
      'deny',
    ]));
    expect(plan.launchCommand.args).not.toContain('/dev/net/tun');
    expect(plan.launchCommand.args).not.toContain('nvx.py');
    expect(plan.launchCommand.args).not.toContain('/bin/sh');
    expect(plan.launchCommand.args).toEqual(expect.arrayContaining([
      '--ro-bind',
      '/etc/resolv.conf',
      '/etc/resolv.conf',
    ]));
    // Bubblewrap binds the run directory at /run/awf-nvx, so argv must carry
    // in-jail paths while the host keeps the real outcome path.
    const openvmmArguments = plan.launchCommand.args.slice(
      plan.launchCommand.args.indexOf('/opt/awf-nvx/openvmm') + 1,
    );
    expect(openvmmArguments).toEqual([
      '--machine',
      'microvm',
      '--paused',
      '--microvm-sandbox-block',
      'distro:file:/run/awf-nvx/distro.erofs,ro',
      '--microvm-sandbox-block',
      'scratch:file:/run/awf-nvx/scratch.ext4',
      '--microvm-workload-identity',
      '65534:65534',
      '--microvm-lifecycle',
      'one-shot',
      '--single-process',
      '--hypervisor',
      'kvm',
      '--memory',
      '512M',
      '--kernel',
      '/opt/awf-nvx/vmlinux',
      '--initrd',
      '/opt/awf-nvx/initramfs.cpio.gz',
      '--cmdline',
      'nvx_sandbox=1 ' +
      'nvx_layer=distro,0xd0003000,11111111-1111-4111-8111-111111111111 ' +
      'nvx_scratch=0xd0006000,ext4 nvx_entrypoint=/bin/true ' +
      'nvx_hostname=awf-nvx nvx_arg=--version nvx_pids_max=257',
      '--net',
      `${plan.networkPlan.guestIp}/${plan.networkPlan.guestPrefixLength}`,
      '--network-profile',
      'portable',
      '--network-egress',
      'deny',
      '--network-ingress',
      'deny',
      ...plan.networkPlan.allowedEndpoints.flatMap(({ ip, port }) => [
        '--network-egress-allow',
        `${ip}/32:tcp:${port}`,
      ]),
      '--host-loopback',
      'deny',
      '--microvm-report',
      '/run/awf-nvx/outcome.json',
    ]);
    expect(openvmmArguments.join(' ')).not.toContain(`/run/awf-nvx/runs/${RUN_ID}`);
    expect(plan.outcomePath).toBe(`/run/awf-nvx/runs/${RUN_ID}/outcome.json`);
  });

  it('rejects a filesystem bundle staged outside the canonical run directory', () => {
    expect(() => buildNvxPhase3dLaunchPlan({
      runId: RUN_ID,
      tools,
      identity: { name: `awfnvx-${RUN_ID.slice(0, 20)}`, uid: 23001, gid: 23002 },
      filesystem: {
        ...filesystemBundle(),
        runDirectory: `/tmp/awf/nvx-images/${RUN_ID}`,
      },
      execution: { entrypoint: '/bin/true' },
      network: { infrastructureBridge: 'br-awf', enableApiProxy: false },
    })).toThrow(/canonical run directory/);
  });

  it('keeps nvx absent from the external runtime registry until evidence is accepted', () => {
    expect(() => runtimeUsesComposeAgent('nvx')).toThrow(/reserved.*not available/);
  });

  it('derives NVX network policy from the canonical namespace and deny-by-default rules', () => {
    expect(createNvxAccountName(RUN_ID)).toMatch(/^awfnvx-a1b2c3d4e5[a-f0-9]{10}$/);
    const plan = createNvxNetworkPlan(RUN_ID, {
      infrastructureBridge: 'br-awf',
      enableApiProxy: false,
      tapOwnerUid: 23001,
      tapOwnerGid: 23002,
    });
    const nftTableName = plan.nftTableName;
    expect(plan.namespaceName).toBe(`awfnvx-${RUN_ID}`);
    expect(nftTableName).toMatch(/^awf_nvx_[a-f0-9]{12}$/);
  });
});
