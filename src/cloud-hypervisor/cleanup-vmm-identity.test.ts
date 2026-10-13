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
const baseline = ['user::rw-', 'group::rw-', 'mask::rw-', 'other::rw-'];

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
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.setfacl) {
        await expect(fs.access(path.join(root, '.device-acl-lock'))).resolves.toBeUndefined();
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === tools.getfacl) {
        await expect(fs.access(path.join(root, '.device-acl-lock'))).resolves.toBeUndefined();
        return { exitCode: 0, stdout: `${baseline.join('\n')}\n`, stderr: '' };
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
    )).rejects.toThrow(/ACL restoration validation failed/);
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
