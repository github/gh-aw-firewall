import {
  CloudHypervisorVmmIdentityManager,
  cloudHypervisorVmmIdentityTestHelpers,
  createAccountName,
  resolveTemporaryVmmAclUids,
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
const baselineAcl = ['user::rw-', 'group::rw-', 'other::rw-'];
const restoredAclArgument = `--set=${baselineAcl.join(',')}`;

describe('temporary VMM ACL identity classification', () => {
  const entry = ['user::rw-', 'user:2001:rw-', 'group::rw-', 'mask::rw-', 'other::---'];

  it('ignores similarly prefixed accounts that are not exact AWF VMM identities', async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: 'awfvmm-backup:x:2001:2002:AWF Cloud Hypervisor backup:' +
        '/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run)).resolves.toEqual([]);
  });

  it.each([
    ['returned not found', async () => ({ exitCode: 2, stdout: '', stderr: '' })],
    ['threw not found', async () => {
      throw Object.assign(new Error('missing'), { exitCode: 2 });
    }],
  ])('ignores an ACL uid whose passwd lookup %s', async (_name, run) => {
    await expect(resolveTemporaryVmmAclUids(entry, tools, run)).resolves.toEqual([]);
  });

  it.each([
    ['returns an error', async () => ({ exitCode: 1, stdout: '', stderr: 'denied' })],
    ['throws an error', async () => {
      throw new Error('lookup failed');
    }],
  ])('fails closed when passwd lookup %s', async (_name, run) => {
    await expect(resolveTemporaryVmmAclUids(entry, tools, run)).rejects.toThrow(
      /denied|lookup failed/,
    );
  });

  it('rejects an exact VMM account whose numeric passwd identity changed', async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: 'awfvmm-0123456789abcdef0123:x:2002:2003:' +
        'AWF Cloud Hypervisor run:/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/account uid changed/);
  });

  it('fails closed when exact VMM account validation fails', async () => {
    const name = 'awfvmm-0123456789abcdef0123';
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent && args[1] === '2001') {
        return {
          stdout: `${name}:x:2001:2002:invalid:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u') {
        return { exitCode: 1, stdout: '', stderr: 'id denied' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/id denied/);
  });

  it('rejects an exact VMM account without the AWF comment marker', async () => {
    const name = 'awfvmm-0123456789abcdef0123';
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent) {
        return {
          stdout: `${name}:x:2001:2002:invalid:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u') return { stdout: '2001\n', stderr: '' };
      if (command === tools.id && args[0] === '-g') return { stdout: '2002\n', stderr: '' };
      if (command === tools.id && args[0] === '-G') return { stdout: '2002\n', stderr: '' };
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/unsafe passwd state/);
  });

  it('rejects an exact VMM account whose resolved uid differs from its ACL uid', async () => {
    const name = 'awfvmm-0123456789abcdef0123';
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent && args[1] === '2001') {
        return {
          stdout: `${name}:x:2001:2002:AWF Cloud Hypervisor run:` +
            '/nonexistent:/usr/sbin/nologin\n',
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u') {
        return { stdout: '2002\n', stderr: '' };
      }
      if (command === tools.id && args[0] === '-g') {
        return { stdout: '2003\n', stderr: '' };
      }
      if (command === tools.id && args[0] === '-G') {
        return { stdout: '2003\n', stderr: '' };
      }
      if (command === tools.getent && args[1] === name) {
        return {
          stdout: `${name}:x:2002:2003:AWF Cloud Hypervisor run:` +
            '/nonexistent:/usr/sbin/nologin\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/account uid changed/);
  });
});

function dependencies(
  overrides: Partial<CloudHypervisorVmmIdentityDependencies> = {},
  userdelRemovesGroup = true,
) {
  let lockExists = false;
  let accountExists = false;
  let groupExists = false;
  let accountName = '';
  const ownerContents = new Map<string, string>();
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
      if (userdelRemovesGroup) groupExists = false;
      return { stdout: '', stderr: '' };
    }
    if (command === tools.groupdel) {
      groupExists = false;
      return { stdout: '', stderr: '' };
    }
    if (command === tools.setfacl) {
      const devicePath = args[0] === '--modify' ? args[2] : args[1];
      if (args[0] === '--modify') aclPaths.add(devicePath);
      else aclPaths.delete(devicePath);
      return { stdout: '', stderr: '' };
    }
    if (command === tools.getfacl) {
      return {
        stdout: [
          'user::rw-',
          ...(aclPaths.has(args[2]) ? ['user:23001:rw-', 'mask::rw-'] : []),
          'group::rw-',
          'other::rw-',
          '',
        ].join('\n'),
        stderr: '',
      };
    }
    if (command === tools.getent) {
      if (args[0] === 'group') {
        if (!groupExists) throw Object.assign(new Error('missing group'), { exitCode: 2 });
        return { stdout: `${accountName}:x:23002:\n`, stderr: '' };
      }
      if (/^\d+$/.test(args[1]) && args[1] !== '23001') {
        throw Object.assign(new Error('missing account'), { exitCode: 2 });
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
    writeFile: jest.fn(async (filePath, contents) => {
      ownerContents.set(filePath, contents);
    }),
    readFile: jest.fn(async (filePath) => ownerContents.get(filePath) ?? ''),
    rm: jest.fn(async (directory) => {
      if (directory.endsWith('.account-lock')) lockExists = false;
      for (const filePath of ownerContents.keys()) {
        if (filePath.startsWith(`${directory}/`)) ownerContents.delete(filePath);
      }
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

type CleanupFailure = 'userdel' | 'groupdel' | 'group-probe' | 'dual';

async function cleanupFailureScenario(failure: CleanupFailure) {
  const runnerBaseline = [
    'user::rw-',
    'user:1001:rw-',
    'group::rw-',
    'mask::rw-',
    'other::rw-',
  ];
  let currentAcl = [...runnerBaseline];
  let accountExists = false;
  let groupExists = false;
  let accountName = '';
  let deletionStarted = false;
  let restorationAttempts = 0;
  const observer = {
    prepareAccount: jest.fn().mockResolvedValue(undefined),
    captureIdentity: jest.fn().mockResolvedValue(undefined),
    prepareAcl: jest.fn().mockResolvedValue(undefined),
    releaseAcl: jest.fn().mockResolvedValue(undefined),
  };
  const base = dependencies();
  base.deps.run = jest.fn(async (command, args) => {
    if (command === tools.useradd) {
      accountExists = true;
      groupExists = true;
      accountName = args[args.length - 1];
      return { stdout: '', stderr: '' };
    }
    if (command === tools.id) {
      if (!accountExists) {
        throw Object.assign(new Error('missing account'), { exitCode: 1 });
      }
      if (args[0] === '-u') return { stdout: '23001\n', stderr: '' };
      if (args[0] === '-g') return { stdout: '23002\n', stderr: '' };
      return { stdout: '23002\n', stderr: '' };
    }
    if (command === tools.getent && args[0] === 'passwd') {
      if (/^\d+$/.test(args[1]) && args[1] !== '23001') {
        throw Object.assign(new Error('missing account'), { exitCode: 2 });
      }
      if (!accountExists) {
        throw Object.assign(new Error('missing account'), { exitCode: 2 });
      }
      return {
        stdout: `${accountName}:x:23001:23002:AWF Cloud Hypervisor:/nonexistent:/usr/sbin/nologin\n`,
        stderr: '',
      };
    }
    if (command === tools.getent && args[0] === 'group') {
      if (failure === 'group-probe' && deletionStarted) {
        throw new Error('group existence probe failed');
      }
      if (!groupExists) {
        throw Object.assign(new Error('missing group'), { exitCode: 2 });
      }
      return { stdout: `${accountName}:x:23002:\n`, stderr: '' };
    }
    if (command === tools.getfacl) {
      return { stdout: `${currentAcl.join('\n')}\n`, stderr: '' };
    }
    if (command === tools.setfacl && args[0] === '--modify') {
      currentAcl = [
        'user::rw-',
        'user:1001:rw-',
        'user:23001:rw-',
        'group::rw-',
        'mask::rw-',
        'other::rw-',
      ];
      return { stdout: '', stderr: '' };
    }
    if (command === tools.setfacl) {
      restorationAttempts += 1;
      if (failure === 'dual' && restorationAttempts === 3) {
        throw new Error('final setfacl failed');
      }
      currentAcl = [...runnerBaseline];
      return { stdout: '', stderr: '' };
    }
    if (command === tools.userdel) {
      deletionStarted = true;
      accountExists = false;
      currentAcl = ['user::rw-', 'group::rw-', 'mask::rw-', 'other::rw-'];
      if (failure === 'userdel' || failure === 'dual') {
        throw new Error('userdel failed after mutation');
      }
      return { stdout: '', stderr: '' };
    }
    if (command === tools.groupdel) {
      groupExists = false;
      if (failure === 'groupdel') {
        throw new Error('groupdel failed after mutation');
      }
      return { stdout: '', stderr: '' };
    }
    if (command === tools.ip) {
      return { stdout: 'vmt123: tap persist user 23001 group 23002\n', stderr: '' };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  });
  const manager = new CloudHypervisorVmmIdentityManager(
    `cleanup-${failure}`,
    tools,
    base.deps,
    observer,
  );
  await manager.allocate();
  await manager.withDeviceAccess(async () => undefined, false);
  return {
    manager,
    observer,
    runnerBaseline,
    currentAcl: () => currentAcl,
    restorationAttempts: () => restorationAttempts,
  };
}

describe('CloudHypervisorVmmIdentityManager', () => {
  it('does not classify similarly prefixed non-AWF accounts as temporary VMM identities', async () => {
    const run = jest.fn(async () => ({
      stdout: 'awfvmm-backup:x:23003:23002:AWF Cloud Hypervisor:/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    }));

    await expect(resolveTemporaryVmmAclUids(
      ['user:23003:rw-'],
      tools,
      run,
    )).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('creates a no-login system account, validates resources, grants ACLs, and removes exact state', async () => {
    const { deps, run } = dependencies();
    const observer = {
      prepareAccount: jest.fn().mockResolvedValue(undefined),
      captureIdentity: jest.fn().mockResolvedValue(undefined),
      prepareAcl: jest.fn().mockResolvedValue(undefined),
      releaseAcl: jest.fn().mockResolvedValue(undefined),
    };
    const manager = new CloudHypervisorVmmIdentityManager('run-1', tools, deps, observer);

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
    const useraddCall = run.mock.calls.findIndex(([command]) => command === tools.useradd);
    expect(observer.prepareAccount.mock.invocationCallOrder[0])
      .toBeLessThan(run.mock.invocationCallOrder[useraddCall]);
    expect(observer.captureIdentity).toHaveBeenCalledWith(identity);

    await manager.validateOwnedPaths(['/run/awf/kernel', '/run/awf/rootfs']);
    await manager.validateTapOwnership(tools.ip, 'awfvm-123', 'vmt123');
    const operation = jest.fn().mockResolvedValue(undefined);
    await manager.withDeviceAccess(operation);
    for (const devicePath of ['/dev/kvm', '/dev/net/tun']) {
      const prepareCall = observer.prepareAcl.mock.calls.findIndex(([value]) => value === devicePath);
      const grantCall = run.mock.calls.findIndex(([command, args]) =>
        command === tools.setfacl && args[0] === '--modify' && args[2] === devicePath);
      expect(observer.prepareAcl.mock.invocationCallOrder[prepareCall])
        .toBeLessThan(run.mock.invocationCallOrder[grantCall]);
      const revokeCall = run.mock.calls.findIndex(([command, args]) =>
        command === tools.setfacl &&
        args[0] === restoredAclArgument &&
        args[1] === devicePath);
      expect(run.mock.invocationCallOrder[grantCall])
        .toBeLessThan(operation.mock.invocationCallOrder[0]);
      expect(operation.mock.invocationCallOrder[0])
        .toBeLessThan(run.mock.invocationCallOrder[revokeCall]);
      expect(observer.releaseAcl).not.toHaveBeenCalledWith(devicePath);
    }
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/kvm'],
    );
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/net/tun'],
    );

    await manager.cleanup();
    for (const devicePath of ['/dev/kvm', '/dev/net/tun']) {
      expect(observer.releaseAcl).toHaveBeenCalledWith(devicePath);
    }
    expect(run).toHaveBeenCalledWith(tools.userdel, [identity.name]);
    expect(run).not.toHaveBeenCalledWith(tools.groupdel, [identity.name]);
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      [restoredAclArgument, '/dev/kvm'],
    );
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      [restoredAclArgument, '/dev/net/tun'],
    );
  });

  it('preserves a distinct runner KVM ACE through locked account and group deletion', async () => {
    const runnerBaseline = [
      'user::rw-',
      'user:1001:rw-',
      'group::rw-',
      'mask::rw-',
      'other::rw-',
    ];
    let currentAcl = [...runnerBaseline];
    let accountExists = false;
    let groupExists = false;
    let accountName = '';
    let deviceLockHeld = false;
    const observer = {
      prepareAccount: jest.fn().mockResolvedValue(undefined),
      captureIdentity: jest.fn().mockResolvedValue(undefined),
      prepareAcl: jest.fn().mockResolvedValue(undefined),
      releaseAcl: jest.fn().mockResolvedValue(undefined),
    };
    const base = dependencies();
    const originalMkdir = base.deps.mkdir;
    const originalRm = base.deps.rm;
    base.deps.mkdir = jest.fn(async (directory, options) => {
      await originalMkdir(directory, options);
      if (directory.endsWith('.device-acl-lock')) deviceLockHeld = true;
    });
    base.deps.rm = jest.fn(async (directory, options) => {
      await originalRm(directory, options);
      if (directory.endsWith('.device-acl-lock')) deviceLockHeld = false;
    });
    const lockedCommands: string[] = [];
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.useradd) {
        accountExists = true;
        groupExists = true;
        accountName = args[args.length - 1];
        return { stdout: '', stderr: '' };
      }
      if (command === tools.id) {
        if (!accountExists) throw Object.assign(new Error('missing account'), { exitCode: 1 });
        if (args[0] === '-u') return { stdout: '23001\n', stderr: '' };
        if (args[0] === '-g') return { stdout: '23002\n', stderr: '' };
        return { stdout: '23002\n', stderr: '' };
      }
      if (command === tools.getent && args[0] === 'passwd') {
        if (/^\d+$/.test(args[1]) && args[1] !== '23001') {
          throw Object.assign(new Error('missing account'), { exitCode: 2 });
        }
        if (!accountExists) throw Object.assign(new Error('missing account'), { exitCode: 2 });
        return {
          stdout: `${accountName}:x:23001:23002:AWF Cloud Hypervisor:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (command === tools.getent && args[0] === 'group') {
        if (!groupExists) throw Object.assign(new Error('missing group'), { exitCode: 2 });
        return { stdout: `${accountName}:x:23002:\n`, stderr: '' };
      }
      if (command === tools.getfacl) {
        if (deviceLockHeld) lockedCommands.push('getfacl');
        return { stdout: `${currentAcl.join('\n')}\n`, stderr: '' };
      }
      if (command === tools.setfacl && args[0] === '--modify') {
        currentAcl = [
          'user::rw-',
          'user:1001:rw-',
          'user:23001:rw-',
          'group::rw-',
          'mask::rw-',
          'other::rw-',
        ];
        return { stdout: '', stderr: '' };
      }
      if (command === tools.setfacl) {
        expect(deviceLockHeld).toBe(true);
        lockedCommands.push('setfacl');
        currentAcl = [...runnerBaseline];
        return { stdout: '', stderr: '' };
      }
      if (command === tools.userdel) {
        expect(deviceLockHeld).toBe(true);
        lockedCommands.push('userdel');
        accountExists = false;
        currentAcl = ['user::rw-', 'group::rw-', 'mask::rw-', 'other::rw-'];
        return { stdout: '', stderr: '' };
      }
      if (command === tools.groupdel) {
        expect(deviceLockHeld).toBe(true);
        lockedCommands.push('groupdel');
        groupExists = false;
        return { stdout: '', stderr: '' };
      }
      if (command === tools.ip) {
        return { stdout: 'vmt123: tap persist user 23001 group 23002\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });
    const manager = new CloudHypervisorVmmIdentityManager(
      'runner-ace',
      tools,
      base.deps,
      observer,
    );

    await manager.allocate();
    await manager.withDeviceAccess(async () => undefined, false);
    expect(observer.releaseAcl).not.toHaveBeenCalled();
    lockedCommands.length = 0;
    await manager.cleanup();

    expect(currentAcl).toEqual(runnerBaseline);
    expect(lockedCommands).toEqual([
      'getfacl', 'setfacl', 'getfacl',
      'userdel', 'groupdel',
      'setfacl', 'getfacl',
    ]);
    expect(observer.releaseAcl).toHaveBeenCalledWith('/dev/kvm');
    expect(deviceLockHeld).toBe(false);
  });

  it('fails closed on a same-length final ACL mismatch after account deletion', async () => {
    const runnerBaseline = [
      'user::rw-',
      'user:1001:rw-',
      'group::rw-',
      'mask::rw-',
      'other::rw-',
    ];
    let restorationCount = 0;
    let accountDeleted = false;
    let currentAcl = [...runnerBaseline];
    const observer = {
      prepareAccount: jest.fn().mockResolvedValue(undefined),
      captureIdentity: jest.fn().mockResolvedValue(undefined),
      prepareAcl: jest.fn().mockResolvedValue(undefined),
      releaseAcl: jest.fn().mockResolvedValue(undefined),
    };
    const base = dependencies();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.getfacl) {
        if (accountDeleted && restorationCount >= 2) {
          return {
            stdout: 'user::rw-\nuser:1002:rw-\ngroup::rw-\nmask::rw-\nother::rw-\n',
            stderr: '',
          };
        }
        return { stdout: `${currentAcl.join('\n')}\n`, stderr: '' };
      }
      if (command === tools.setfacl && args[0] === '--modify') {
        currentAcl = [
          'user::rw-',
          'user:1001:rw-',
          'user:23001:rw-',
          'group::rw-',
          'mask::rw-',
          'other::rw-',
        ];
        return { stdout: '', stderr: '' };
      }
      if (command === tools.setfacl && args[0].startsWith('--set=')) {
        restorationCount += 1;
        currentAcl = [...runnerBaseline];
        return { stdout: '', stderr: '' };
      }
      if (command === tools.userdel) accountDeleted = true;
      return originalRun(command, args);
    });
    const manager = new CloudHypervisorVmmIdentityManager(
      'same-length-mismatch',
      tools,
      base.deps,
      observer,
    );

    await manager.allocate();
    await manager.withDeviceAccess(async () => undefined, false);
    await expect(manager.cleanup()).rejects.toThrow(
      /before=user::rw-,user:<id>:rw-,group::rw-,mask::rw-,other::rw-.*after=user::rw-,user:<id>:rw-,group::rw-,mask::rw-,other::rw-/,
    );
    expect(restorationCount).toBe(3);
    expect(observer.releaseAcl).not.toHaveBeenCalled();
  });

  it.each([
    ['userdel', /userdel failed after mutation/],
    ['groupdel', /groupdel failed after mutation/],
    ['group-probe', /group existence probe failed/],
  ] as const)(
    'reapplies the exact baseline and retains durable intent after %s failure',
    async (failure, expectedError) => {
      const scenario = await cleanupFailureScenario(failure);

      await expect(scenario.manager.cleanup()).rejects.toThrow(expectedError);
      expect(scenario.restorationAttempts()).toBe(3);
      expect(scenario.currentAcl()).toEqual(scenario.runnerBaseline);
      expect(scenario.observer.releaseAcl).not.toHaveBeenCalled();
    },
  );

  it('aggregates deletion and final restoration failures without releasing durable intent', async () => {
    const scenario = await cleanupFailureScenario('dual');

    await expect(scenario.manager.cleanup()).rejects.toThrow(
      /userdel failed after mutation.*final ACL restoration also failed:.*final setfacl failed/,
    );
    expect(scenario.restorationAttempts()).toBe(3);
    expect(scenario.observer.releaseAcl).not.toHaveBeenCalled();
  });

  it('propagates account existence probe failures instead of treating them as absence', async () => {
    const base = dependencies();
    base.deps.run = jest.fn(async (command) => {
      if (command === tools.id) throw new Error('account existence probe failed');
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(new CloudHypervisorVmmIdentityManager(
      'account-probe',
      tools,
      base.deps,
    ).allocate()).rejects.toThrow(/account existence probe failed/);
  });

  it('does not grant TAP device access for a no-network VM', async () => {
    const { deps, run } = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('script-run', tools, deps);
    await manager.allocate();

    await manager.withDeviceAccess(async () => undefined, false);

    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--modify', 'user:23001:rw', '/dev/kvm'],
    );
    expect(run).not.toHaveBeenCalledWith(
      tools.setfacl,
      expect.arrayContaining(['/dev/net/tun']),
    );
  });

  it('serializes concurrent allocation calls on one manager', async () => {
    let releaseUseradd!: () => void;
    const useraddGate = new Promise<void>((resolve) => {
      releaseUseradd = resolve;
    });

    const base = dependencies({
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.useradd) await useraddGate;
      return originalRun(command, args);
    });
    const manager = new CloudHypervisorVmmIdentityManager('concurrent', tools, base.deps);

    const first = manager.allocate();
    const second = manager.allocate();
    releaseUseradd();

    const [firstIdentity, secondIdentity] = await Promise.all([first, second]);
    expect(secondIdentity).toEqual(firstIdentity);
    expect((base.deps.run as jest.Mock).mock.calls.filter(
      ([command]) => command === tools.useradd,
    )).toHaveLength(1);
  });

  it('revokes device access when the protected operation fails', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('failed-operation', tools, base.deps);
    await manager.allocate();

    await expect(manager.withDeviceAccess(async () => {
      throw new Error('vm.create failed');
    })).rejects.toThrow('vm.create failed');
    for (const devicePath of ['/dev/kvm', '/dev/net/tun']) {
      expect(base.run).toHaveBeenCalledWith(
        tools.setfacl,
        [restoredAclArgument, devicePath],
      );
    }
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

  it('preserves provisional state and reports a failed allocation rollback', async () => {
    const base = dependencies();
    const originalRun = base.deps.run;
    let failRollback = true;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.userdel && failRollback) throw new Error('userdel failed');
      const result = await originalRun(command, args);
      if (command === tools.id && args[0] === '-G') return { stdout: '23002 27\n', stderr: '' };
      return result;
    });
    const manager = new CloudHypervisorVmmIdentityManager('rollback', tools, base.deps);

    await expect(manager.allocate()).rejects.toThrow(
      /account allocation failed.*inherited supplementary groups.*rollback also failed.*userdel failed/,
    );
    await expect(manager.allocate()).rejects.toThrow(/account cleanup is still pending/);
    failRollback = false;
    await expect(manager.cleanup()).resolves.toBeUndefined();
    expect((base.deps.run as jest.Mock).mock.calls.filter(
      ([command]) => command === tools.userdel,
    )).toHaveLength(2);
  });

  it('rejects mismatched staged path and TAP ownership', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('ownership', tools, base.deps);
    await manager.allocate();
    base.deps.lstat = jest.fn().mockResolvedValue({ uid: 999, gid: 998 });
    await expect(manager.validateOwnedPaths(['/run/awf/rootfs']))
      .rejects.toThrow(/path ownership mismatch/);
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.ip) {
        return { stdout: 'other: tap persist user 23001 group 23002\n', stderr: '' };
      }
      return originalRun(command, args);
    });
    await expect(manager.validateTapOwnership(tools.ip, 'awfvm-123', 'vmt123'))
      .rejects.toThrow(/was not found/);
  });

  it('rolls back accounts with unsafe passwd state', async () => {
    const base = dependencies();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.getent && args[0] === 'passwd') {
        return { stdout: `${args[1]}:x:23001:23002:AWF:/home/unsafe:/bin/bash\n`, stderr: '' };
      }
      return originalRun(command, args);
    });
    const manager = new CloudHypervisorVmmIdentityManager('unsafe-passwd', tools, base.deps);

    await expect(manager.allocate()).rejects.toThrow(/unsafe passwd state/);
    expect(base.deps.run).toHaveBeenCalledWith(
      tools.userdel,
      [expect.stringMatching(/^awfvmm-/)],
    );
  });

  it('fails closed when a device ACL grant or removal cannot be verified', async () => {
    const grantBase = dependencies();
    const grantOriginalRun = grantBase.deps.run;
    grantBase.deps.run = jest.fn(async (command, args) => {
      const result = await grantOriginalRun(command, args);
      if (command === tools.getfacl) {
        return { stdout: `${baselineAcl.join('\n')}\n`, stderr: '' };
      }
      return result;
    });
    const grantManager = new CloudHypervisorVmmIdentityManager('acl-grant', tools, grantBase.deps);
    await grantManager.allocate();
    await expect(grantManager.withDeviceAccess(async () => undefined))
      .rejects.toThrow(/ACL validation failed/);

    const removalBase = dependencies();
    const removalManager = new CloudHypervisorVmmIdentityManager(
      'acl-removal',
      tools,
      removalBase.deps,
    );
    const identity = await removalManager.allocate();
    const removalOriginalRun = removalBase.deps.run;
    removalBase.deps.run = jest.fn(async (command, args) => {
      if (command === tools.setfacl && args[0] === restoredAclArgument) {
        return { stdout: '', stderr: '' };
      }
      return removalOriginalRun(command, args);
    });

    await expect(removalManager.withDeviceAccess(async () => undefined))
      .rejects.toThrow(/ACL restoration failed/);
    expect(removalBase.deps.run).not.toHaveBeenCalledWith(tools.userdel, [identity.name]);
  });

  it('refuses to delete an account whose uid/gid changed before cleanup', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('reused-account', tools, base.deps);
    await manager.allocate();
    await manager.withDeviceAccess(async () => undefined);
    (base.deps.run as jest.Mock).mockClear();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.id && args[0] === '-u') return { stdout: '24001\n', stderr: '' };
      if (command === tools.id && args[0] === '-g') return { stdout: '24002\n', stderr: '' };
      if (command === tools.id && args[0] === '-G') return { stdout: '24002\n', stderr: '' };
      if (command === tools.getent && args[0] === 'passwd') {
        return {
          stdout: `${args[1]}:x:24001:24002:AWF:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      return originalRun(command, args);
    });

    await expect(manager.cleanup()).rejects.toThrow(/Refusing to remove reused/);
    expect(base.deps.run).not.toHaveBeenCalledWith(
      tools.setfacl,
      expect.arrayContaining(['--remove']),
    );
    expect(base.deps.run).not.toHaveBeenCalledWith(
      tools.userdel,
      [expect.stringMatching(/^awfvmm-/)],
    );
  });

  it('removes a residual private group when userdel leaves it behind', async () => {
    const base = dependencies({}, false);
    const manager = new CloudHypervisorVmmIdentityManager('residual-group', tools, base.deps);
    const identity = await manager.allocate();

    await manager.cleanup();
    expect(base.deps.run).toHaveBeenCalledWith(tools.groupdel, [identity.name]);
  });

  it('rejects invalid allocator identity output and missing lock-owner process metadata', async () => {
    const invalidBase = dependencies();
    const invalidOriginalRun = invalidBase.deps.run;
    invalidBase.deps.run = jest.fn(async (command, args) => {
      const result = await invalidOriginalRun(command, args);
      if (command === tools.id && args[0] === '-u') return { stdout: '0\n', stderr: '' };
      return result;
    });
    const invalidManager = new CloudHypervisorVmmIdentityManager(
      'invalid-identity',
      tools,
      invalidBase.deps,
    );
    await expect(invalidManager.allocate()).rejects.toThrow(/invalid uid/);

    const missingStart = dependencies({
      processStartTime: jest.fn().mockResolvedValue(undefined),
    });
    const missingStartManager = new CloudHypervisorVmmIdentityManager(
      'missing-start',
      tools,
      missingStart.deps,
    );
    await expect(missingStartManager.allocate()).rejects.toThrow(/Cannot determine AWF process start time/);
  });

  it('treats a missing process as a stale lock owner', async () => {
    await expect(cloudHypervisorVmmIdentityTestHelpers.readProcessStartTime(2_147_483_647))
      .resolves.toBeUndefined();
  });

  it('strictly validates lock owners and positive numeric account identifiers', () => {
    const valid = { pid: 1234, startTime: '99', nonce: 'a'.repeat(32) };
    expect(cloudHypervisorVmmIdentityTestHelpers.isLockOwner(valid)).toBe(true);
    for (const invalid of [
      { ...valid, pid: 0 },
      { ...valid, pid: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, startTime: 99 },
      { ...valid, startTime: 'not-numeric' },
      { ...valid, nonce: 123 },
      { ...valid, nonce: 'not-a-nonce' },
    ]) {
      expect(cloudHypervisorVmmIdentityTestHelpers.isLockOwner(invalid as never)).toBe(false);
    }
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(valid, valid)).toBe(true);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, nonce: 'b'.repeat(32) },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, pid: 4321 },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, startTime: '100' },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, nonce: 'invalid' },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.parsePositiveInteger('42\n', 'uid')).toBe(42);
    expect(() => cloudHypervisorVmmIdentityTestHelpers.parsePositiveInteger(
      '9007199254740992',
      'uid',
    )).toThrow(/unsafe uid/);
    expect(cloudHypervisorVmmIdentityTestHelpers.formatError(new Error('failure'))).toBe('failure');
    expect(cloudHypervisorVmmIdentityTestHelpers.formatError('failure')).toBe('failure');
    const processFields = Array.from({ length: 20 }, (_, index) => String(index));
    processFields[19] = '777';
    expect(cloudHypervisorVmmIdentityTestHelpers.parseProcessStatStartTime(
      `123 (command with spaces) ${processFields.join(' ')}`,
    )).toBe('777');
  });

  it('runs account tools with the hardened default command executor', async () => {
    await expect(cloudHypervisorVmmIdentityTestHelpers.defaultRun('/usr/bin/true', []))
      .resolves.toEqual({ stdout: '', stderr: '' });
    await expect(cloudHypervisorVmmIdentityTestHelpers.defaultRun('/usr/bin/false', []))
      .rejects.toThrow(/exited with code 1/);
    await expect(cloudHypervisorVmmIdentityTestHelpers.defaultSleep(0)).resolves.toBeUndefined();
    await expect(cloudHypervisorVmmIdentityTestHelpers.readProcessStartTime(
      1234,
      jest.fn().mockResolvedValue(
        `1234 (command) ${Array.from({ length: 20 }, (_, index) =>
          index === 19 ? '888' : String(index)).join(' ')}`,
      ),
    )).resolves.toBe('888');
    await expect(cloudHypervisorVmmIdentityTestHelpers.readProcessStartTime(
      1234,
      jest.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' })),
    )).rejects.toThrow('denied');
  }, 30_000);

  it('rejects a pre-existing generated account and malformed TAP ownership', async () => {
    const existing = dependencies();
    existing.deps.run = jest.fn(async (command, args) => {
      if (command === tools.id && args[0] === '-u') return { stdout: '23001\n', stderr: '' };
      return existing.run(command, args);
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'existing-account',
      tools,
      existing.deps,
    ).allocate()).rejects.toThrow(/account already exists/);

    const tapBase = dependencies();
    const tapManager = new CloudHypervisorVmmIdentityManager('tap-fields', tools, tapBase.deps);
    await tapManager.allocate();
    for (const tapLine of [
      'vmt123: tap persist group 23002',
      'vmt123: tap persist user 24001 group 23002',
      'vmt123: tap persist user 23001',
      'vmt123: tap persist user 23001 group 24002',
    ]) {
      tapBase.deps.run = jest.fn(async (command, args) => {
        if (command === tools.ip) return { stdout: `${tapLine}\n`, stderr: '' };
        return tapBase.run(command, args);
      });
      await expect(tapManager.validateTapOwnership(tools.ip, 'awfvm-123', 'vmt123'))
        .rejects.toThrow(/TAP ownership mismatch/);
    }
  });

  it('waits for a live account-lock owner instead of reclaiming it', async () => {
    let lockExists = true;
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let ownerContents = `${JSON.stringify(owner)}\n`;
    const base = dependencies({
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
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      processStartTime: jest.fn(async (pid) => pid === owner.pid ? owner.startTime : '99'),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('live-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rm).toHaveBeenCalledTimes(1);
  });

  it('waits for a fresh incomplete account lock', async () => {
    let lockExists = true;
    let ownerContents = '{';
    const base = dependencies({
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
      lstat: jest.fn().mockResolvedValue({
        uid: 0,
        gid: 0,
        ino: 42,
        mtimeMs: Date.now(),
      }),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('fresh-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
  });

  it('backs off when another process owns stale-lock reclamation', async () => {
    let lockExists = true;
    let reaperExists = true;
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let ownerContents = `${JSON.stringify(owner)}\n`;
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.reaper')) {
          if (reaperExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          reaperExists = true;
        } else if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn(async (filePath) => ({
        uid: 0,
        gid: 0,
        ino: 42,
        mtimeMs: filePath.endsWith('.reaper') ? 0 : Date.now(),
      })),
      processStartTime: jest.fn(async (pid) => pid === 4321 ? 'stale' : '99'),
      rmdir: jest.fn(async () => {
        reaperExists = false;
      }),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('reaper-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rmdir).toHaveBeenCalled();
  });

  it('does not reap a lock whose inode changes after claiming the reaper', async () => {
    let lockExists = true;
    let ownerContents = `${JSON.stringify({
      pid: 4321,
      startTime: '77',
      nonce: 'a'.repeat(32),
    })}\n`;
    let lockStatsReads = 0;
    const base = dependencies({
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
      lstat: jest.fn(async () => ({
        uid: 0,
        gid: 0,
        ino: ++lockStatsReads === 1 ? 42 : 43,
        mtimeMs: 0,
      })),
      processStartTime: jest.fn(async (pid) => pid === 4321 ? 'stale' : '99'),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('replaced-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rm).toHaveBeenCalledTimes(1);
  });

  it('revalidates stale-lock liveness and freshness after claiming the reaper', async () => {
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let lockExists = true;
    let ownerContents = `${JSON.stringify(owner)}\n`;
    let ownerChecks = 0;
    const becameLive = dependencies({
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
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      processStartTime: jest.fn(async (pid) => {
        if (pid !== owner.pid) return '99';
        return ownerChecks++ === 0 ? 'stale' : owner.startTime;
      }),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'became-live-lock',
      tools,
      becameLive.deps,
    ).allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });

    lockExists = true;
    ownerContents = '';
    let statsReads = 0;
    const becameFresh = dependencies({
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
      lstat: jest.fn(async () => ({
        uid: 0,
        gid: 0,
        ino: 42,
        mtimeMs: statsReads++ === 0 ? 0 : Date.now(),
      })),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'became-fresh-lock',
      tools,
      becameFresh.deps,
    ).allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
  });

  it('surfaces unexpected stale-lock metadata errors', async () => {
    const unreadable = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      }),
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      readFile: jest.fn(async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'unreadable-lock',
      tools,
      unreadable.deps,
    ).allocate()).rejects.toThrow('denied');

    const reaperDenied = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory === '/run/awf-cloud-hypervisor') return;
        throw Object.assign(
          new Error('denied'),
          { code: directory.endsWith('.reaper') ? 'EACCES' : 'EEXIST' },
        );
      }),
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      readFile: jest.fn(async () => ''),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'reaper-denied',
      tools,
      reaperDenied.deps,
    ).allocate()).rejects.toThrow('denied');
  });

  it('handles missing and unexpected lock-stat failures', async () => {
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(10_001);
    const missing = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      }),
      lstat: jest.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'missing-lock',
      tools,
      missing.deps,
    ).allocate()).rejects.toThrow(/Timed out waiting/);
    now.mockRestore();

    const denied = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      }),
      lstat: jest.fn(async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'lock-stat-denied',
      tools,
      denied.deps,
    ).allocate()).rejects.toThrow('denied');
  });

  it('backs off when a competing reaper disappears', async () => {
    let lockExists = true;
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let ownerContents = `${JSON.stringify(owner)}\n`;
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.reaper')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn(async (filePath) => {
        if (filePath.endsWith('.reaper')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return { uid: 0, gid: 0, ino: 42, mtimeMs: 0 };
      }),
      processStartTime: jest.fn(async (pid) => pid === owner.pid ? 'stale' : '99'),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'vanished-reaper',
      tools,
      base.deps,
    ).allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
  });

  it('detects identity replacement while waiting to grant device access', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('changed-identity', tools, base.deps);
    await manager.allocate();
    let lockAttempt = 0;
    base.deps.mkdir = jest.fn(async (directory) => {
      if (directory.endsWith('.device-acl-lock') && lockAttempt++ === 0) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
    });
    base.deps.lstat = jest.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    base.deps.sleep = jest.fn(async () => {
      Reflect.set(manager, 'identity', undefined);
    });

    await expect(manager.withDeviceAccess(async () => undefined)).rejects.toThrow(/identity changed/);
  });

  it('rejects removal when acquired lock ownership changes', async () => {
    let ownerContents = '';
    const base = dependencies({
      writeFile: jest.fn(async (_filePath, contents) => {
        const owner = JSON.parse(contents) as { pid: number; startTime: string; nonce: string };
        ownerContents = JSON.stringify({ ...owner, nonce: 'b'.repeat(32) });
      }),
      readFile: jest.fn(async () => ownerContents),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'changed-owner',
      tools,
      base.deps,
    ).allocate()).rejects.toThrow(/lock ownership changed unexpectedly/);
  });

  it('does not release the uid when a device ACL cannot be removed', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('run-3', tools, base.deps);
    const identity = await manager.allocate();
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (
        command === tools.setfacl &&
        args[0] === restoredAclArgument &&
        args[1] === '/dev/kvm'
      ) {
        throw new Error('ACL restoration failed');
      }
      return originalRun(command, args);
    });

    await expect(manager.withDeviceAccess(async () => undefined))
      .rejects.toThrow(/ACL cleanup failed/);
    await expect(manager.cleanup()).rejects.toThrow(/ACL cleanup failed/);
    expect(base.deps.run).not.toHaveBeenCalledWith(tools.userdel, [identity.name]);
  });

  it('fails closed if an in-memory device ACL baseline is lost before restoration', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('missing-baseline', tools, base.deps);
    await manager.allocate();
    const operation = async () => {
      (Reflect.get(manager, 'aclBaselines') as Map<string, string[]>).clear();
    };

    await expect(manager.withDeviceAccess(operation))
      .rejects.toThrow(/ACL baseline is missing/);
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
    expect(new CloudHypervisorVmmIdentityManager('default-dependencies', tools)).toBeDefined();
    const first = createAccountName();
    const second = createAccountName();
    expect(first).toMatch(/^awfvmm-[a-f0-9]{20}$/);
    expect(second).not.toBe(first);
    expect(first).not.toContain(String(process.pid));
  });
});
