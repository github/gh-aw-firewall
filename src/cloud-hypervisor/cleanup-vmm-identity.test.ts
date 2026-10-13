import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { resolveCleanupDependencies } from './cleanup-dependencies';
import type { ResolvedCleanupDependencies } from './cleanup-dependencies';
import type { CleanupRecord } from './cleanup-identity';
import { deleteVmmIdentity } from './cleanup-vmm-identity';

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
const baseline = [
  'user::rw-',
  'user:1001:rw-',
  'group::rw-',
  'mask::rw-',
  'other::rw-',
];

function cleanupRecord(aclBaselines?: Record<'/dev/kvm', string[]>): CleanupRecord {
  return {
    version: 1,
    runId: 'acl-recovery',
    owner: {
      pid: process.pid,
      startTime: '1',
      executable: process.execPath,
      executableIdentity: { device: '1', inode: '1' },
      uid: 0,
      gid: 0,
      networkNamespace: 'net:[1]',
    },
    cloudHypervisorBinary: process.execPath,
    paths: {
      runDirectory: '/run/awf-cloud-hypervisor/cloud-hypervisor/acl-recovery',
      cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/acl-recovery',
      virtiofsdShareDirectory: '/run/awf-cloud-hypervisor/virtiofsd/acl-recovery',
    },
    identities: {},
    processes: {},
    vmmIdentity: {
      state: 'live',
      name: 'awfvmm-0123456789abcdef0123',
      uid: 23001,
      gid: 23002,
      aclPaths: ['/dev/kvm'],
      ...(aclBaselines ? { aclBaselines } : {}),
    },
    mounts: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function dependencies(
  root: string,
  run: ResolvedCleanupDependencies['run'],
): ResolvedCleanupDependencies {
  const readFile = (async (
    filePath: Parameters<typeof fs.readFile>[0],
    options?: Parameters<typeof fs.readFile>[1],
  ) => {
    if (String(filePath) === `/proc/${process.pid}/stat`) {
      return `${process.pid} (node) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 777 1`;
    }
    return options === undefined
      ? fs.readFile(filePath)
      : fs.readFile(filePath, options);
  }) as typeof fs.readFile;
  return resolveCleanupDependencies({
    rootDirectory: root,
    processId: process.pid,
    readFile,
    run,
  });
}

describe('Cloud Hypervisor durable VMM identity cleanup', () => {
  let root: string;

  beforeEach(async () => {
    root = path.join(
      process.cwd(),
      '.test-workdir',
      `awf-vmm-cleanup-${randomBytes(6).toString('hex')}`,
    );
    await fs.mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('restores and validates the exact baseline while holding the shared ACL lock', async () => {
    let accountDeleted = false;
    let currentAcl = [...baseline];
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (
        command === tools.setfacl ||
        command === tools.getfacl ||
        command === tools.userdel
      ) {
        await expect(fs.access(path.join(root, '.device-acl-lock'))).resolves.toBeUndefined();
      }
      if (command === tools.setfacl) {
        currentAcl = [...baseline];
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === tools.getfacl) {
        return { exitCode: 0, stdout: `${currentAcl.join('\n')}\n`, stderr: '' };
      }
      if (command === tools.getent && args[0] === 'passwd' && !accountDeleted) {
        return {
          exitCode: 0,
          stdout:
            'awfvmm-0123456789abcdef0123:x:23001:23002:' +
            'AWF Cloud Hypervisor acl-recovery:/nonexistent:/usr/sbin/nologin\n',
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u' && !accountDeleted) {
        return { exitCode: 0, stdout: '23001\n', stderr: '' };
      }
      if (command === tools.id && args[0] === '-u' && accountDeleted) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (command === tools.id && args[0] === '-g') {
        return { exitCode: 0, stdout: '23002\n', stderr: '' };
      }
      if (command === tools.id && args[0] === '-G') {
        return { exitCode: 0, stdout: '23002\n', stderr: '' };
      }
      if (command === tools.userdel) {
        accountDeleted = true;
        currentAcl = ['user::rw-', 'group::rw-', 'mask::rw-', 'other::rw-'];
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === tools.getent || command === tools.id) {
        return { exitCode: 2, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });
    const resolved = dependencies(root, run);

    await expect(deleteVmmIdentity(
      resolved,
      cleanupRecord({ '/dev/kvm': baseline }),
      tools,
    )).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(tools.setfacl, [
      `--set=${baseline.join(',')}`,
      '/dev/kvm',
    ]);
    expect(run.mock.calls.filter(([command]) => command === tools.setfacl)).toHaveLength(2);
    const userdelCall = run.mock.calls.findIndex(([command]) => command === tools.userdel);
    const setfaclCalls = run.mock.calls
      .map(([command], index) => command === tools.setfacl ? index : -1)
      .filter((index) => index >= 0);
    const finalSetfaclCall = setfaclCalls[setfaclCalls.length - 1];
    expect(userdelCall).toBeLessThan(finalSetfaclCall);
    await expect(fs.access(path.join(root, '.device-acl-lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when restored ACL evidence differs from the durable baseline', async () => {
    const run = jest.fn(async (command: string) => {
      if (command === tools.setfacl) return { exitCode: 0, stdout: '', stderr: '' };
      if (command === tools.getfacl) {
        return {
          exitCode: 0,
          stdout: 'user::rw-\ngroup::r--\nmask::r--\nother::---\n',
          stderr: '',
        };
      }
      return { exitCode: 2, stdout: '', stderr: '' };
    });
    const resolved = dependencies(root, run);

    await expect(deleteVmmIdentity(
      resolved,
      cleanupRecord({ '/dev/kvm': baseline }),
      tools,
    )).rejects.toThrow(
      /before=user::rw-,user:<id>:rw-,group::rw-,mask::rw-,other::rw-.*after=user::rw-,group::r--,mask::r--,other::---/,
    );
  });

  it('keeps legacy user-ACE removal fail-closed when no baseline was recorded', async () => {
    let aclPresent = true;
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getfacl) {
        return {
          exitCode: 0,
          stdout: aclPresent ? 'user:23001:rw-\n' : '',
          stderr: '',
        };
      }
      if (command === tools.setfacl && args[0] === '--remove') {
        aclPresent = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === tools.getent || command === tools.id) {
        return { exitCode: 2, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const resolved = dependencies(root, run);

    await expect(deleteVmmIdentity(
      resolved,
      cleanupRecord(),
      tools,
    )).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--remove', 'user:23001', '/dev/kvm'],
    );
  });
});
