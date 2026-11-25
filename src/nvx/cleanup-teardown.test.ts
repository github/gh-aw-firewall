import type { PathLike } from 'fs';
import type { NvxCleanupProcessIdentity, NvxCleanupRecord } from './cleanup-record';
import { NVX_CLEANUP_SCHEMA_VERSION } from './cleanup-record';
import type { NvxCleanupRegistryDependencies, NvxCleanupToolPaths } from './cleanup-registry';
import { NvxCleanupStore } from './cleanup-store';
import {
  removeExactDirectory,
  removeExactFile,
  removeIdentity,
  removeNetwork,
  stopRecordedProcesses,
} from './cleanup-teardown';

const identity: NvxCleanupProcessIdentity = {
  pid: 4242,
  startTimeTicks: '1000',
  executable: '/usr/bin/openvmm',
  executableDevice: '8',
  executableInode: '9',
  uid: 23001,
  gid: 23002,
  networkNamespace: 'net:[4026531840]',
};
const file = { path: '/run/nvx-resource', device: '8', inode: '10' };
const tools: NvxCleanupToolPaths = {
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/sbin/ip',
  iptables: '/usr/sbin/iptables',
  setfacl: '/usr/bin/setfacl',
  userdel: '/usr/sbin/userdel',
};

describe('NVX cleanup teardown helpers', () => {
  let record: NvxCleanupRecord;
  let dependencies: NvxCleanupRegistryDependencies;
  let processes: Map<number, NvxCleanupProcessIdentity>;
  let kill: jest.Mock;
  let sleep: jest.Mock;
  let lstat: jest.Mock;
  let rm: jest.Mock;
  let rmdir: jest.Mock;
  let run: jest.Mock;

  beforeEach(() => {
    processes = new Map([[identity.pid, { ...identity }]]);
    const currentProcess = (filePath: PathLike): NvxCleanupProcessIdentity => {
      const current = processes.get(Number(String(filePath).split('/')[2]));
      if (!current) throw Object.assign(new Error('Process absent'), { code: 'ENOENT' });
      return current;
    };
    const readFile = jest.fn(async (filePath: PathLike) => {
      const current = currentProcess(filePath);
      return String(filePath).endsWith('/stat')
        ? `${current.pid} (openvmm) ${['S', ...Array(18).fill('0'), current.startTimeTicks].join(' ')}`
        : `Uid:\t${Array(4).fill(current.uid).join(' ')}\nGid:\t${Array(4).fill(current.gid).join(' ')}\n`;
    });
    const stat = jest.fn(async (filePath: PathLike) => {
      const current = currentProcess(filePath);
      return { dev: BigInt(current.executableDevice), ino: BigInt(current.executableInode) };
    });
    const readlink = jest.fn(async (filePath: PathLike) => {
      const current = currentProcess(filePath);
      return String(filePath).endsWith('/exe') ? current.executable : current.networkNamespace;
    });
    kill = jest.fn().mockReturnValue(true);
    sleep = jest.fn().mockResolvedValue(undefined);
    lstat = jest.fn().mockResolvedValue({ dev: 8n, ino: 10n });
    rm = jest.fn().mockResolvedValue(undefined);
    rmdir = jest.fn().mockResolvedValue(undefined);
    run = jest.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    dependencies = {
      store: new NvxCleanupStore(),
      pid: 4343,
      readFile: readFile as unknown as NvxCleanupRegistryDependencies['readFile'],
      readlink: readlink as unknown as NvxCleanupRegistryDependencies['readlink'],
      stat: stat as unknown as NvxCleanupRegistryDependencies['stat'],
      lstat: lstat as NvxCleanupRegistryDependencies['lstat'],
      rm,
      rmdir,
      kill,
      sleep,
      run,
      withDeviceAclLock: async (operation) => operation(),
    };
    record = {
      schemaVersion: NVX_CLEANUP_SCHEMA_VERSION,
      runId: 'c'.repeat(32),
      owner: { ...identity, pid: dependencies.pid },
      resources: { deviceAcls: [], openvmm: { ...identity } },
      stages: {
        accountCreated: false,
        artifactSnapshotCreated: false,
        cgroupCreated: false,
        deviceAclsGranted: false,
        networkCreated: false,
        processStarted: true,
        runDirectoryCreated: false,
      },
      updatedAt: new Date().toISOString(),
    };
  });

  describe('process signals', () => {
    it.each([
      { startTimeTicks: '2000' },
      { executable: '/usr/bin/other' },
      { executableDevice: '80' },
      { executableInode: '90' },
      { uid: 23003 },
      { gid: 23004 },
      { networkNamespace: 'net:[4026531841]' },
    ])('does not signal a reused process with changed identity %j', async (changed) => {
      processes.set(identity.pid, { ...identity, ...changed });
      await stopRecordedProcesses(record, dependencies);
      expect(kill).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it('does not signal an absent process', async () => {
      processes.clear();
      await stopRecordedProcesses(record, dependencies);
      expect(kill).not.toHaveBeenCalled();
    });

    it('fails closed on a process inspection error other than ENOENT', async () => {
      jest.mocked(dependencies.readFile).mockRejectedValue(
        Object.assign(new Error('Access denied'), { code: 'EACCES' }),
      );
      await expect(stopRecordedProcesses(record, dependencies)).rejects.toThrow('Access denied');
      expect(kill).not.toHaveBeenCalled();
    });

    it('stops openvmm before the launcher without escalation when SIGTERM succeeds', async () => {
      record.resources.launcher = { ...identity, pid: 4243 };
      processes.set(4243, record.resources.launcher);
      kill.mockImplementation((pid: number) => processes.delete(pid));
      await stopRecordedProcesses(record, dependencies);
      expect(kill.mock.calls).toEqual([[4242, 'SIGTERM'], [4243, 'SIGTERM']]);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('escalates only a still-matching process after the grace period', async () => {
      kill.mockImplementation((pid: number, signal: string) => {
        if (signal === 'SIGKILL') processes.delete(pid);
        return true;
      });
      await stopRecordedProcesses(record, dependencies);
      expect(kill.mock.calls).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
      expect(sleep).toHaveBeenCalledTimes(40);
      expect(sleep).toHaveBeenCalledWith(50);
    });

    it('rechecks identity before SIGKILL when a PID is reused during the grace period', async () => {
      sleep.mockImplementation(async () => {
        if (sleep.mock.calls.length === 40) {
          processes.set(identity.pid, { ...identity, startTimeTicks: '2000' });
        }
      });
      await stopRecordedProcesses(record, dependencies);
      expect(kill.mock.calls).toEqual([[4242, 'SIGTERM']]);
    });

    it('reports a matching process that survives SIGKILL', async () => {
      await expect(stopRecordedProcesses(record, dependencies)).rejects.toThrow(
        'NVX process 4242 did not terminate',
      );
      expect(kill.mock.calls).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
    });
  });

  describe.each(['file', 'directory', 'recursive directory'])('exact %s removal', (kind) => {
    const remove = (
      expected: typeof file | undefined,
      deps: NvxCleanupRegistryDependencies,
    ) => kind === 'file'
      ? removeExactFile(expected, deps)
      : removeExactDirectory(expected, kind === 'recursive directory', deps);

    it.each([{ dev: 80n, ino: 10n }, { dev: 8n, ino: 100n }])(
      'refuses a replaced resource with identity %p',
      async (current) => {
        lstat.mockResolvedValue(current);
        await expect(remove(file, dependencies)).rejects.toThrow(/resource identity changed/);
        expect(rm).not.toHaveBeenCalled();
        expect(rmdir).not.toHaveBeenCalled();
      },
    );

    it('revalidates exact identity before removing the resource', async () => {
      await remove(file, dependencies);
      expect(lstat).toHaveBeenLastCalledWith(file.path, { bigint: true });
      const removal = kind === 'directory' ? rmdir : rm;
      expect(lstat.mock.invocationCallOrder[1]).toBeLessThan(removal.mock.invocationCallOrder[0]);
      if (kind === 'directory') {
        expect(rmdir).toHaveBeenCalledWith(file.path);
      } else {
        expect(rm).toHaveBeenCalledWith(file.path, kind === 'file'
          ? { force: false }
          : { recursive: true, force: false });
      }
    });

    it('skips an unrecorded or absent resource', async () => {
      await remove(undefined, dependencies);
      expect(lstat).not.toHaveBeenCalled();
      lstat.mockRejectedValue(Object.assign(new Error('Absent'), { code: 'ENOENT' }));
      await remove(file, dependencies);
      expect(rm).not.toHaveBeenCalled();
      expect(rmdir).not.toHaveBeenCalled();
    });
  });

  describe('account and device identity', () => {
    beforeEach(() => {
      record.vmmIdentity = {
        state: 'live', name: `awfnvx-${'d'.repeat(20)}`, uid: 23001, gid: 23002,
      };
    });

    it.each([
      { device: '80', inode: '10', uid: 23001 },
      { device: '8', inode: '100', uid: 23001 },
      { device: '8', inode: '10', uid: 23003 },
    ])('does not revoke ACLs or delete accounts for a changed device identity %j', async (acl) => {
      record.resources.deviceAcls.push({ path: '/dev/kvm', permissions: 'rw-', ...acl });
      const name = record.vmmIdentity!.name;
      run.mockImplementation(async (_command: string, args: readonly string[]) => ({
        exitCode: 0,
        stdout: args[0] === 'passwd'
          ? `${name}:x:23001:23002:AWF NVX ${record.runId}:/nonexistent:/usr/sbin/nologin\n`
          : args[0] === 'group'
            ? `${name}:x:23002:\n`
            : '23002\n',
        stderr: '',
      }));
      await expect(removeIdentity(record, tools, dependencies)).rejects.toThrow(
        /device identity changed/,
      );
      expect(run).not.toHaveBeenCalledWith(tools.setfacl, expect.anything());
      expect(run).not.toHaveBeenCalledWith(tools.userdel, expect.anything());
      expect(run).not.toHaveBeenCalledWith(tools.groupdel, expect.anything());
    });

    it('does not revoke device ACLs when the recorded account is absent', async () => {
      record.resources.deviceAcls.push({
        path: '/dev/kvm',
        device: '8',
        inode: '10',
        permissions: 'rw-',
        uid: 23001,
      });
      run.mockResolvedValue({ exitCode: 2, stdout: '', stderr: '' });

      await removeIdentity(record, tools, dependencies);

      expect(run).not.toHaveBeenCalledWith(tools.setfacl, expect.anything());
    });

    it.each([[23003, 23002], [23001, 23004]])(
      'does not delete a reused account with uid %s and gid %s',
      async (uid, gid) => {
        const name = record.vmmIdentity!.name;
        run.mockImplementation(async (_command: string, args: readonly string[]) => ({
          exitCode: 0,
          stdout: args[0] === 'passwd'
            ? `${name}:x:${uid}:${gid}:AWF NVX ${record.runId}:/nonexistent:/usr/sbin/nologin\n`
            : `${name}:x:${gid}:\n`,
          stderr: '',
        }));
        await expect(removeIdentity(record, tools, dependencies)).rejects.toThrow(
          /Refusing to remove reused NVX account/,
        );
        expect(run).not.toHaveBeenCalledWith(tools.userdel, expect.anything());
        expect(run).not.toHaveBeenCalledWith(tools.groupdel, expect.anything());
      },
    );
  });

  describe('network identity', () => {
    beforeEach(() => {
      const resourceToken = 'e'.repeat(12);
      record.network = {
        resourceToken,
        namespaceName: 'awf-nvx-test',
        netnsPath: '/var/run/netns/awf-nvx-test',
        hostVethName: 'host0',
        namespaceVethName: 'ns0',
        tapName: 'tap0',
        infrastructureBridge: 'awfbr0',
        hostForwardRuleComment: `awf-microvm-${resourceToken}`,
      };
      record.resources.networkReservation = {
        ...file, path: `/run/awf-microvm-network/reservations/${resourceToken}.json`,
      };
      record.resources.networkNamespace = { ...file, path: record.network.netnsPath };
      record.resources.hostVeth = { name: 'host0', ifindex: 17 };
      record.resources.namespaceVeth = { name: 'ns0', namespace: 'awf-nvx-test', ifindex: 17 };
      record.resources.tap = { name: 'tap0', namespace: 'awf-nvx-test', ifindex: 17 };
      run.mockImplementation(async (_command: string, args: readonly string[]) => ({
        exitCode: 0,
        stdout: args.includes('show')
          ? JSON.stringify([{ ifname: args[args.length - 1], ifindex: 17 }])
          : '',
        stderr: '',
      }));
    });

    it.each(['networkReservation', 'networkNamespace', 'hostVeth', 'namespaceVeth', 'tap'] as const)(
      'does not delete network resources when %s identity changes',
      async (resource) => {
        if (resource === 'networkReservation' || resource === 'networkNamespace') {
          record.resources[resource] = { ...record.resources[resource]!, inode: '100' };
        } else {
          record.resources[resource] = { ...record.resources[resource]!, ifindex: 18 };
        }
        await expect(removeNetwork(record, tools.ip, tools.iptables, dependencies))
          .rejects.toThrow(/identity changed/);
        expect(run.mock.calls.some(([, args]) => args.includes('delete'))).toBe(false);
        expect(run).not.toHaveBeenCalledWith(tools.iptables, expect.anything());
      },
    );

    it('requires a committed reservation before deleting any network resource', async () => {
      delete record.resources.networkReservation;
      await expect(removeNetwork(record, tools.ip, tools.iptables, dependencies))
        .rejects.toThrow(/without a committed reservation identity/);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('deletes the matching network and bridge rule after revalidation', async () => {
      await removeNetwork(record, tools.ip, tools.iptables, dependencies);
      expect(run.mock.calls.slice(3)).toEqual([
        [tools.ip, ['link', 'delete', 'host0']],
        [tools.ip, ['netns', 'delete', 'awf-nvx-test']],
        ...['-C', '-D'].map((operation) => [tools.iptables, [
          '-t', 'filter', operation, 'DOCKER-USER', '-i', 'awfbr0', '-o', 'awfbr0',
          '-m', 'comment', '--comment', record.network!.hostForwardRuleComment, '-j', 'ACCEPT',
        ]]),
      ]);
    });
  });
});
