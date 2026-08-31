import {
  CloudHypervisorVmmIdentityManager,
  createAccountName,
  type CloudHypervisorVmmIdentityDependencies,
  type CloudHypervisorVmmIdentityToolPaths,
} from './vmm-identity';

const tools: CloudHypervisorVmmIdentityToolPaths = {
  getfacl: '/usr/bin/getfacl',
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/bin/ip',
  setfacl: '/usr/bin/setfacl',
  useradd: '/usr/sbin/useradd',
  userdel: '/usr/sbin/userdel',
};

function dependencies(overrides: Partial<CloudHypervisorVmmIdentityDependencies> = {}) {
  let lockExists = false;
  let accountExists = false;
  let groupExists = false;
  let accountName = '';
  let ownerContents = '';
  const aclPaths = new Set<string>();
  const run = jest.fn(async (command: string, args: readonly string[]) => {
    if (command === tools.useradd) {
      accountExists = true;
      groupExists = true;
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
      const devicePath = args[2];
      if (args[0] === '--modify') aclPaths.add(devicePath);
      else aclPaths.delete(devicePath);
      return { stdout: '', stderr: '' };
    }
    if (command === tools.getfacl) {
      return {
        stdout: aclPaths.has(args[2]) ? 'user:23001:rw-\n' : '',
        stderr: '',
      };
    }
    if (command === tools.getent) {
      if (args[0] === 'group') {
        if (!groupExists) throw Object.assign(new Error('missing group'), { exitCode: 2 });
        return { stdout: `${accountName}:x:23002:\n`, stderr: '' };
      }
      return {
        stdout: `${accountName}:x:23001:23002:AWF Cloud Hypervisor:/nonexistent:/usr/sbin/nologin\n`,
        stderr: '',
      };
    }
    if (command === tools.id) {
      if (!accountExists) throw Object.assign(new Error('missing account'), { exitCode: 1 });
      if (args[0] === '-u') return { stdout: '23001\n', stderr: '' };
      if (args[0] === '-g') return { stdout: '23002\n', stderr: '' };
      return { stdout: '23002\n', stderr: '' };
    }
    if (command === tools.ip) {
      return { stdout: 'vmt123: tap persist user 23001 group 23002\n', stderr: '' };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const deps: CloudHypervisorVmmIdentityDependencies = {
    mkdir: jest.fn(async (directory) => {
      if (directory.endsWith('.account-lock')) {
        if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        lockExists = true;
      }
    }),
    writeFile: jest.fn(async (_filePath, contents) => {
      ownerContents = contents;
    }),
    readFile: jest.fn(async () => ownerContents),
    rm: jest.fn(async (directory) => {
      if (directory.endsWith('.account-lock')) lockExists = false;
    }),
    rmdir: jest.fn().mockResolvedValue(undefined),
    lstat: jest.fn().mockResolvedValue({ uid: 23001, gid: 23002, ino: 1, mtimeMs: 0 }),
    run,
    sleep: jest.fn().mockResolvedValue(undefined),
    pid: 1234,
    processStartTime: jest.fn().mockResolvedValue('99'),
    ...overrides,
  };
  return { deps, run };
}

describe('CloudHypervisorVmmIdentityManager', () => {
  it('creates a no-login system account, validates resources, grants ACLs, and removes exact state', async () => {
    const { deps, run } = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('run-1', tools, deps);

    const identity = await manager.allocate();
    expect(identity).toEqual({
      name: expect.stringMatching(/^awfvmm-[a-f0-9]{20}$/),
      uid: 23001,
      gid: 23002,
    });
    expect(run).toHaveBeenCalledWith(tools.useradd, expect.arrayContaining([
      '--system',
      '--user-group',
      '--no-create-home',
      '--home-dir', '/nonexistent',
      '--shell', '/usr/sbin/nologin',
    ]));

    await manager.validateOwnedPaths(['/run/awf/kernel', '/run/awf/rootfs']);
    await manager.validateTapOwnership(tools.ip, 'awfvm-123', 'vmt123');
    await manager.grantDeviceAccess();
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/kvm'],
    );
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/net/tun'],
    );

    await manager.cleanup();
    expect(run).toHaveBeenCalledWith(tools.userdel, [identity.name]);
    expect(run).not.toHaveBeenCalledWith(tools.groupdel, [identity.name]);
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--remove', 'user:23001', '/dev/kvm'],
    );
  });

  it('rejects inherited supplementary groups and rolls back the account', async () => {
    const base = dependencies();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      const result = await originalRun(command, args);
      if (command === tools.id && args[0] === '-G') return { stdout: '23002 27\n', stderr: '' };
      return result;
    });
    const manager = new CloudHypervisorVmmIdentityManager('run-2', tools, base.deps);

    await expect(manager.allocate()).rejects.toThrow(/inherited supplementary groups/);
    expect(base.deps.run).toHaveBeenCalledWith(
      tools.userdel,
      [expect.stringMatching(/^awfvmm-/)],
    );
  });

  it('does not release the uid when a device ACL cannot be removed', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('run-3', tools, base.deps);
    const identity = await manager.allocate();
    await manager.grantDeviceAccess();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (
        command === tools.setfacl &&
        args[0] === '--remove' &&
        args[2] === '/dev/kvm'
      ) {
        throw new Error('ACL removal failed');
      }
      return originalRun(command, args);
    });

    await expect(manager.cleanup()).rejects.toThrow(/ACL cleanup failed/);
    expect(base.deps.run).not.toHaveBeenCalledWith(tools.userdel, [identity.name]);
  });

  it('recovers a stale zero-byte lock without racing a replacement owner', async () => {
    const base = dependencies();
    let lockExists = true;
    let reaperExists = false;
    let ownerContents = '';
    base.deps.mkdir = jest.fn(async (directory) => {
      if (directory.endsWith('.reaper')) {
        if (reaperExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        reaperExists = true;
      } else if (directory.endsWith('.account-lock')) {
        if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        lockExists = true;
      }
    });
    base.deps.writeFile = jest.fn(async (filePath, contents) => {
      if (filePath.endsWith('owner.json')) ownerContents = contents;
    });
    base.deps.readFile = jest.fn(async () => ownerContents);
    base.deps.lstat = jest.fn(async (filePath) => {
      if (filePath.endsWith('.reaper') && !reaperExists) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (!lockExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { uid: 0, gid: 0, ino: 42, mtimeMs: 0 };
    });
    base.deps.rm = jest.fn(async (filePath) => {
      if (filePath.endsWith('.account-lock')) {
        lockExists = false;
        reaperExists = false;
      }
    });
    base.deps.rmdir = jest.fn(async () => {
      if (!reaperExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      reaperExists = false;
    });
    const manager = new CloudHypervisorVmmIdentityManager('run-4', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rm).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/.account-lock',
      { recursive: true, force: true },
    );
  });

  it('uses random non-PID account names for repeated allocations', () => {
    const first = createAccountName('same-run');
    const second = createAccountName('same-run');
    expect(first).toMatch(/^awfvmm-[a-f0-9]{20}$/);
    expect(second).not.toBe(first);
    expect(first).not.toContain(String(process.pid));
  });
});
