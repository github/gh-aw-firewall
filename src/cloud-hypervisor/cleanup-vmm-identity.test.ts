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

function cleanupRecord(
  aclBaselines?: Partial<Record<'/dev/kvm' | '/dev/net/tun', string[]>>,
  options: {
    runId?: string;
    name?: string;
    uid?: number;
    gid?: number;
    aclPaths?: Array<'/dev/kvm' | '/dev/net/tun'>;
    accessedAclPaths?: Array<'/dev/kvm' | '/dev/net/tun'>;
    aclTemporaryUids?: Partial<Record<'/dev/kvm' | '/dev/net/tun', number[]>>;
  } = {},
): CleanupRecord {
  const runId = options.runId ?? 'acl-recovery';
  return {
    version: 1,
    runId,
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
      runDirectory: `/run/awf-cloud-hypervisor/cloud-hypervisor/${runId}`,
      cgroupPath: `/sys/fs/cgroup/awf-cloud-hypervisor/${runId}`,
      virtiofsdShareDirectory: `/run/awf-cloud-hypervisor/virtiofsd/${runId}`,
    },
    identities: {},
    processes: {},
    vmmIdentity: {
      state: 'live',
      name: options.name ?? 'awfvmm-0123456789abcdef0123',
      uid: options.uid ?? 23001,
      gid: options.gid ?? 23002,
      aclPaths: options.aclPaths ?? ['/dev/kvm'],
      ...(options.accessedAclPaths ? {
        accessedAclPaths: options.accessedAclPaths,
      } : {}),
      ...(aclBaselines ? { aclBaselines } : {}),
      ...(options.aclTemporaryUids ? {
        aclTemporaryUids: options.aclTemporaryUids,
      } : {}),
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
        if (/^\d+$/.test(args[1]) && args[1] !== '23001') {
          return { exitCode: 2, stdout: '', stderr: '' };
        }
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

  it.each([
    ['crash after launch restoration', [], false],
    ['partial launch-intent release', ['/dev/kvm'], false],
    ['partial preparation retry', [], true],
  ] as const)(
    'journals fresh baselines for every accessed device before account deletion: %s',
    async (_name, pendingPaths, retryAfterPersistFailure) => {
      const deviceAcls = new Map([
        ['/dev/kvm', [...baseline]],
        ['/dev/net/tun', [...baseline]],
      ]);
      let accountExists = true;
      let groupExists = true;
      const record = cleanupRecord(
        pendingPaths.length > 0 ? { '/dev/kvm': [...baseline] } : undefined,
        {
          aclPaths: [...pendingPaths],
          accessedAclPaths: ['/dev/kvm', '/dev/net/tun'],
          aclTemporaryUids: pendingPaths.length > 0 ? { '/dev/kvm': [] } : undefined,
        },
      );
      const run = jest.fn(async (command: string, args: readonly string[]) => {
        if (command === tools.getfacl) {
          return {
            exitCode: 0,
            stdout: `${deviceAcls.get(args[2])!.join('\n')}\n`,
            stderr: '',
          };
        }
        if (command === tools.setfacl && args[0].startsWith('--set=')) {
          deviceAcls.set(args[1], args[0].slice('--set='.length).split(','));
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === tools.getent && args[0] === 'passwd') {
          if (args[1] === '1001') {
            return {
              exitCode: 0,
              stdout: 'runner:x:1001:1001:GitHub Actions:/home/runner:/bin/bash\n',
              stderr: '',
            };
          }
          if (!accountExists) return { exitCode: 2, stdout: '', stderr: '' };
          return {
            exitCode: 0,
            stdout: `${record.vmmIdentity!.name}:x:23001:23002:` +
              'AWF Cloud Hypervisor acl-recovery:/nonexistent:/usr/sbin/nologin\n',
            stderr: '',
          };
        }
        if (command === tools.getent && args[0] === 'group') {
          if (!groupExists) return { exitCode: 2, stdout: '', stderr: '' };
          return {
            exitCode: 0,
            stdout: `${record.vmmIdentity!.name}:x:23002:\n`,
            stderr: '',
          };
        }
        if (command === tools.id) {
          if (!accountExists) return { exitCode: 1, stdout: '', stderr: '' };
          if (args[0] === '-u') return { exitCode: 0, stdout: '23001\n', stderr: '' };
          return { exitCode: 0, stdout: '23002\n', stderr: '' };
        }
        if (command === tools.userdel) {
          accountExists = false;
          deviceAcls.set('/dev/kvm', ['user::rw-', 'group::rw-', 'other::rw-']);
          deviceAcls.set('/dev/net/tun', ['user::rw-', 'group::rw-', 'other::rw-']);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === tools.groupdel) {
          groupExists = false;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      });
      let failNextPersist = retryAfterPersistFailure;
      const persist = jest.fn(async () => {
        if (failNextPersist) {
          failNextPersist = false;
          throw new Error('cleanup record persistence failed');
        }
      });
      const cleanup = () => deleteVmmIdentity(
        dependencies(root, run),
        record,
        tools,
        persist,
      );
      if (retryAfterPersistFailure) {
        await expect(cleanup()).rejects.toThrow(/cleanup record persistence failed/);
        expect(record.vmmIdentity?.aclPaths).toEqual([]);
      }
      await expect(cleanup()).resolves.toBeUndefined();

      expect(record.vmmIdentity?.aclPaths).toEqual(['/dev/kvm', '/dev/net/tun']);
      expect(record.vmmIdentity?.aclBaselines).toEqual({
        '/dev/kvm': baseline,
        '/dev/net/tun': baseline,
      });
      expect(persist).toHaveBeenCalledTimes(
        2 - pendingPaths.length + (retryAfterPersistFailure ? 1 : 0),
      );
      const userdelOrder = run.mock.invocationCallOrder[
        run.mock.calls.findIndex(([command]) => command === tools.userdel)
      ];
      for (const persistOrder of persist.mock.invocationCallOrder) {
        expect(persistOrder).toBeLessThan(userdelOrder);
      }
      expect(deviceAcls.get('/dev/kvm')).toEqual(baseline);
      expect(deviceAcls.get('/dev/net/tun')).toEqual(baseline);
      expect(accountExists).toBe(false);
      expect(groupExists).toBe(false);
    },
  );

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

  it.each([
    ['earlier identity first', [999, 997]],
    ['later identity first', [997, 999]],
  ] as const)(
    'preserves the exact runner baseline for two overlapping identities: %s',
    async (_name, cleanupOrder) => {
      const runnerUid = 1001;
      const identities = new Map([
        [999, {
          runId: 'first-run',
          name: 'awfvmm-11111111111111111111',
          gid: 1999,
          baseline: [
            'user::rw-', `user:${runnerUid}:rw-`,
            'group::rw-', 'mask::rw-', 'other::---',
          ],
          temporaryUids: [],
        }],
        [997, {
          runId: 'second-run',
          name: 'awfvmm-22222222222222222222',
          gid: 1997,
          baseline: [
            'user::rw-', 'user:999:rw-', `user:${runnerUid}:rw-`,
            'group::rw-', 'mask::rw-', 'other::---',
          ],
          temporaryUids: [999],
        }],
      ]);
      const accountExists = new Map([[999, true], [997, true]]);
      const groupExists = new Map([[999, true], [997, true]]);
      let currentAcl = [
        'user::rw-', 'user:997:rw-', 'user:999:rw-', `user:${runnerUid}:rw-`,
        'group::rw-', 'mask::rw-', 'other::---',
      ];
      const run = jest.fn(async (command: string, args: readonly string[]) => {
        if (command === tools.getfacl) {
          return { exitCode: 0, stdout: `${currentAcl.join('\n')}\n`, stderr: '' };
        }
        if (command === tools.setfacl && args[0].startsWith('--set=')) {
          currentAcl = args[0].slice('--set='.length).split(',');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === tools.getent && args[0] === 'passwd') {
          const query = args[1];
          const entry = [...identities.entries()].find(([uid, identity]) =>
            String(uid) === query || identity.name === query);
          if (!entry || !accountExists.get(entry[0])) {
            return { exitCode: 2, stdout: '', stderr: '' };
          }
          const [uid, identity] = entry;
          return {
            exitCode: 0,
            stdout: `${identity.name}:x:${uid}:${identity.gid}:` +
              `AWF Cloud Hypervisor ${identity.runId}:/nonexistent:/usr/sbin/nologin\n`,
            stderr: '',
          };
        }
        if (command === tools.getent && args[0] === 'group') {
          const entry = [...identities.entries()].find(([, identity]) =>
            identity.name === args[1]);
          if (!entry || !groupExists.get(entry[0])) {
            return { exitCode: 2, stdout: '', stderr: '' };
          }
          return {
            exitCode: 0,
            stdout: `${entry[1].name}:x:${entry[1].gid}:\n`,
            stderr: '',
          };
        }
        if (command === tools.id) {
          const entry = [...identities.entries()].find(([, identity]) =>
            identity.name === args[1]);
          if (!entry || !accountExists.get(entry[0])) {
            return { exitCode: 1, stdout: '', stderr: '' };
          }
          const [uid, identity] = entry;
          return {
            exitCode: 0,
            stdout: `${args[0] === '-u' ? uid : identity.gid}\n`,
            stderr: '',
          };
        }
        if (command === tools.userdel) {
          const entry = [...identities.entries()].find(([, identity]) =>
            identity.name === args[0])!;
          accountExists.set(entry[0], false);
          currentAcl = ['user::rw-', 'group::rw-', 'mask::rw-', 'other::---'];
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === tools.groupdel) {
          const entry = [...identities.entries()].find(([, identity]) =>
            identity.name === args[0])!;
          groupExists.set(entry[0], false);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      });
      const resolved = dependencies(root, run);

      for (const uid of cleanupOrder) {
        const identity = identities.get(uid)!;
        await deleteVmmIdentity(
          resolved,
          cleanupRecord(
            { '/dev/kvm': identity.baseline },
            {
              runId: identity.runId,
              name: identity.name,
              uid,
              gid: identity.gid,
              aclTemporaryUids: { '/dev/kvm': identity.temporaryUids },
            },
          ),
          tools,
        );
      }

      expect(currentAcl).toEqual([
        'user::rw-', `user:${runnerUid}:rw-`,
        'group::rw-', 'mask::rw-', 'other::---',
      ]);
      expect(currentAcl).not.toContain('user:999:rw-');
      expect(currentAcl).not.toContain('user:997:rw-');
    },
  );
});
