import type {
  CloudHypervisorVmmIdentityDependencies,
  CloudHypervisorVmmIdentityToolPaths,
} from './vmm-identity';

export const tools: CloudHypervisorVmmIdentityToolPaths = {
  getfacl: '/usr/bin/getfacl',
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/bin/ip',
  setfacl: '/usr/bin/setfacl',
  useradd: '/usr/sbin/useradd',
  userdel: '/usr/sbin/userdel',
};

export function dependencies(
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
