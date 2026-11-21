import { promises as fs } from 'fs';
import * as path from 'path';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import { createCleanupRegistryTestHarness } from './cleanup-registry.test-utils';
import { createMicrovmNetworkPlan } from '../microvm/network';
import { createCleanupHandle } from './cleanup-handle';
import type { CleanupRecord, ProcessIdentity } from './cleanup-identity';
import { createCloudHypervisorEmptyNetworkNamespacePlan } from './network-namespace';

function createHandleFixture() {
  const identity: ProcessIdentity = {
    pid: 5000,
    startTime: '1000',
    executable: '/usr/bin/worker',
    executableIdentity: { device: '1', inode: '5000' },
    uid: 1000,
    gid: 1000,
    networkNamespace: 'net:[5000]',
  };
  const record: CleanupRecord = {
    version: 1,
    runId: 'handle-run',
    owner: { ...identity, pid: 4242, networkNamespace: 'net:[4000]' },
    cloudHypervisorBinary: '/usr/bin/cloud-hypervisor',
    paths: {
      runDirectory: '/tmp/awf-handle/cloud-hypervisor/handle-run',
      cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/handle-run',
      virtiofsdShareDirectory: '/tmp/awf-handle/virtiofsd/handle-run',
    },
    identities: {},
    processes: {},
    mounts: [],
    updatedAt: 'initial',
  };
  const persist = jest.fn(async () => {
    expect(record.updatedAt).not.toBe('initial');
  });
  const options = {
    recordPath: '/tmp/awf-handle/pending-cleanup/handle-run.json',
    record,
    ipPath: '/usr/bin/ip',
    persist,
    unlink: jest.fn<ReturnType<typeof fs.unlink>, Parameters<typeof fs.unlink>>()
      .mockResolvedValue(undefined),
    realpath: jest.fn().mockResolvedValue(identity.executable) as typeof fs.realpath,
    sleep: jest.fn().mockResolvedValue(undefined),
    pathExists: jest.fn().mockResolvedValue(false),
    captureFileIdentity: jest.fn().mockResolvedValue(identity.executableIdentity),
    captureInterfaceIdentity: jest.fn().mockResolvedValue({ name: 'captured', ifindex: 10 }),
    captureProcessIdentity: jest.fn().mockResolvedValue(identity),
    readMounts: jest.fn().mockResolvedValue([]),
  };
  const plan = createMicrovmNetworkPlan(record.runId, {
    infrastructureBridge: 'awfbr0',
    enableApiProxy: false,
    tapOwnerUid: 1000,
    tapOwnerGid: 1000,
  });
  return { record, options, plan, handle: createCleanupHandle(options), persist };
}

describe('cleanup handle record-commit rules', () => {
  it('commits one network plan and refuses either kind of replacement', async () => {
    const { record, handle, plan, persist } = createHandleFixture();
    await handle.captureNetworkPlan(plan);
    expect(record.network).toMatchObject({
      mode: 'primary', namespaceName: plan.namespaceName, netnsPath: plan.netnsPath,
    });
    await expect(handle.captureNetworkPlan(plan)).rejects.toThrow('network plan is already committed');
    await expect(handle.captureEmptyNetworkNamespace(
      createCloudHypervisorEmptyNetworkNamespacePlan(record.runId),
    )).rejects.toThrow('network namespace is already committed');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('allows only netns resources in a committed empty network namespace', async () => {
    const { record, options, handle, plan, persist } = createHandleFixture();
    await expect(handle.captureNetworkResource('netns')).rejects.toThrow('network plan is not committed');
    const empty = createCloudHypervisorEmptyNetworkNamespacePlan(record.runId);
    await handle.captureEmptyNetworkNamespace(empty);
    expect(record.network).toEqual(empty);
    await expect(handle.captureNetworkPlan(plan)).rejects.toThrow('network plan is already committed');
    await expect(handle.captureEmptyNetworkNamespace(empty))
      .rejects.toThrow('network namespace is already committed');
    await expect(handle.captureNetworkResource('tap')).rejects.toThrow('cannot capture tap');
    await handle.captureNetworkResource('netns');
    expect(options.captureFileIdentity).toHaveBeenCalledWith(empty.netnsPath);
    expect(record.identities.netns).toEqual({ device: '1', inode: '5000' });
    expect(options.captureInterfaceIdentity).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('checks run-scoped paths before either network commit', async () => {
    const { record, handle, plan, persist } = createHandleFixture();
    await expect(handle.captureNetworkPlan({ ...plan, runId: 'other-run' }))
      .rejects.toThrow('not scoped to one run');
    Object.assign(record.paths, { cgroupPath: '/sys/fs/cgroup/other-run' });
    await expect(handle.captureNetworkPlan(plan)).rejects.toThrow('not scoped to one run');
    await expect(handle.captureEmptyNetworkNamespace(
      createCloudHypervisorEmptyNetworkNamespacePlan(record.runId),
    )).rejects.toThrow('not scoped to one run');
    expect(record.network).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it('requires a matching pending account before committing a live VMM identity', async () => {
    const { record, handle, persist } = createHandleFixture();
    const identity = { name: 'awfvmm-0123456789abcdef0123', uid: 23001, gid: 23002 };
    await expect(handle.captureVmmIdentity(identity)).rejects.toThrow('pending account');
    await expect(handle.prepareVmmAccount('root')).rejects.toThrow('Unsafe or duplicate');
    await handle.prepareVmmAccount(identity.name);
    expect(record.vmmIdentity).toEqual({
      state: 'pending', name: identity.name, aclPaths: [], accessedAclPaths: [],
    });
    await expect(handle.prepareVmmAccount(identity.name)).rejects.toThrow('Unsafe or duplicate');
    await expect(handle.captureVmmIdentity({ ...identity, name: 'other' }))
      .rejects.toThrow('pending account');
    await expect(handle.captureVmmIdentity({ ...identity, uid: 0 })).rejects.toThrow('pending account');
    await expect(handle.captureVmmIdentity({ ...identity, gid: 1.5 })).rejects.toThrow('pending account');
    await handle.captureVmmIdentity(identity);
    expect(record.vmmIdentity).toMatchObject({ ...identity, state: 'live' });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('requires a live VMM identity and persists an identical ACL grant only once', async () => {
    const { record, handle, persist } = createHandleFixture();
    const baseline = ['user::rw-', 'group::rw-', 'other::---'];
    await expect(handle.prepareVmmAcl('/dev/kvm', baseline)).rejects.toThrow('before ACL grant');
    await expect(handle.releaseVmmAcl('/dev/kvm')).rejects.toThrow('before ACL release');
    await handle.prepareVmmAccount('awfvmm-0123456789abcdef0123');
    await expect(handle.prepareVmmAcl('/dev/kvm', baseline)).rejects.toThrow('before ACL grant');
    await handle.captureVmmIdentity({ name: 'awfvmm-0123456789abcdef0123', uid: 23001, gid: 23002 });
    await expect(handle.prepareVmmAcl('/dev/kvm', ['invalid'])).rejects.toThrow();
    await handle.prepareVmmAcl('/dev/kvm', baseline);
    await handle.prepareVmmAcl('/dev/kvm', baseline);
    expect(record.vmmIdentity?.aclPaths).toEqual(['/dev/kvm']);
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('commits each directory identity before persisting and propagates write failures', async () => {
    const { record, options, handle, persist } = createHandleFixture();
    await handle.captureRunDirectory();
    await handle.captureCgroup();
    await handle.captureVirtiofsdResources();
    expect(options.captureFileIdentity.mock.calls).toEqual([
      [record.paths.runDirectory], [record.paths.cgroupPath],
    ]);
    expect(record.identities).toEqual({
      runDirectory: { device: '1', inode: '5000' }, cgroup: { device: '1', inode: '5000' },
    });
    expect(options.readMounts).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(3);
    persist.mockRejectedValueOnce(new Error('write failed'));
    await expect(handle.captureRunDirectory()).rejects.toThrow('write failed');
    expect(record.identities.runDirectory).toEqual({ device: '1', inode: '5000' });
  });

  it('completes without persisting and ignores only missing-record unlink errors', async () => {
    const { options, handle, persist } = createHandleFixture();
    await handle.complete();
    expect(options.unlink).toHaveBeenCalledWith(options.recordPath);
    options.unlink.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(handle.complete()).resolves.toBeUndefined();
    options.unlink.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EPERM' }));
    await expect(handle.complete()).rejects.toThrow('denied');
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('cleanup handle integration', () => {
  let harness: Awaited<ReturnType<typeof createCleanupRegistryTestHarness>>;

  beforeEach(async () => {
    harness = await createCleanupRegistryTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('VMM account and process capture', () => {
    it('removes revoked device ACLs from durable cleanup intent', async () => {
      const paths = harness.runPaths('released-vmm-acl');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.createPending(paths, process.execPath, '/usr/bin/ip');
      const account = 'awfvmm-0123456789abcdef0123';
      await handle.prepareVmmAccount(account);
      await handle.captureVmmIdentity({ name: account, uid: 23001, gid: 23002 });
      const baseline = [
        'user::rw-', 'user:23003:rw-', 'group::rw-', 'mask::rw-', 'other::rw-',
      ];
      const temporaryUids = [23003];
      await handle.prepareVmmAcl('/dev/kvm', baseline, temporaryUids);
      await expect(handle.prepareVmmAcl('/dev/kvm', baseline, [23004])).rejects.toThrow(
        /baseline changed/,
      );
      await expect(handle.prepareVmmAcl('/dev/kvm', [
        'user::rw-', 'group::r--', 'other::---',
      ])).rejects.toThrow(/baseline changed/);

      const recordPath = path.join(
        harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`,
      );
      const preparedRecord = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        vmmIdentity: {
          accessedAclPaths?: string[];
          aclTemporaryUids?: Record<string, number[]>;
          accessedAclBaselines?: Record<string, string[]>;
          accessedAclTemporaryUids?: Record<string, number[]>;
        };
      };
      expect(preparedRecord.vmmIdentity.accessedAclPaths).toEqual(['/dev/kvm']);
      expect(preparedRecord.vmmIdentity.aclTemporaryUids).toEqual({ '/dev/kvm': temporaryUids });
      expect(preparedRecord.vmmIdentity.accessedAclBaselines).toEqual({
        '/dev/kvm': baseline,
      });
      expect(preparedRecord.vmmIdentity.accessedAclTemporaryUids).toEqual({
        '/dev/kvm': temporaryUids,
      });

      await handle.releaseVmmAcl('/dev/kvm');

      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        vmmIdentity: {
          aclPaths: string[];
          accessedAclPaths?: string[];
          aclBaselines?: object;
          aclTemporaryUids?: object;
          accessedAclBaselines?: object;
          accessedAclTemporaryUids?: object;
        };
      };
      expect(record.vmmIdentity.aclPaths).toEqual([]);
      expect(record.vmmIdentity.accessedAclPaths).toEqual(['/dev/kvm']);
      expect(record.vmmIdentity.aclBaselines).toEqual({});
      expect(record.vmmIdentity.aclTemporaryUids).toEqual({});
      expect(record.vmmIdentity.accessedAclBaselines).toEqual({ '/dev/kvm': baseline });
      expect(record.vmmIdentity.accessedAclTemporaryUids).toEqual({
        '/dev/kvm': temporaryUids,
      });
      await expect(handle.releaseVmmAcl('/dev/kvm')).rejects.toThrow(/intent is missing/);
    });

    it('validates process registration and completes idempotently', async () => {
      const paths = harness.runPaths('process-registration');
      const handle = await new DurableCloudHypervisorCleanupRegistry(harness.dependencies()).create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );

      await expect(handle.prepareProcess('__proto__', process.execPath, '/sock')).rejects.toThrow(
        /Unsafe cleanup process key/,
      );
      await expect(handle.captureProcess('missing', 5000)).rejects.toThrow(
        /identity was not prepared/,
      );
      await handle.complete();
      await expect(handle.complete()).resolves.toBeUndefined();
    });

    it('times out instead of committing a process whose executable never matches', async () => {
      const now = jest.spyOn(Date, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(2_001);
      try {
        const paths = harness.runPaths('process-mismatch');
        const handle = await new DurableCloudHypervisorCleanupRegistry(harness.dependencies()).create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        harness.state.daemonExecutableLink = '/usr/bin/not-the-prepared-binary';

        await expect(handle.captureProcess('worker', 5000)).rejects.toThrow(
          /did not match its prepared cleanup identity/,
        );
      } finally {
        now.mockRestore();
      }
    });

    it('waits for the trusted exec chain to settle before committing process identity', async () => {
      const paths = harness.runPaths('process-settles');
      const sleep = jest.fn(async () => {
        harness.state.daemonExecutableLink = process.execPath;
      });
      const handle = await new DurableCloudHypervisorCleanupRegistry(
        harness.dependencies({ sleep }),
      ).create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      await handle.prepareProcess('worker', process.execPath, '/sock');
      harness.state.daemonExecutableLink = '/usr/bin/setpriv';

      await expect(handle.captureProcess('worker', 5000)).resolves.toBeUndefined();
      expect(sleep).toHaveBeenCalled();
    });

    it('records the settled private network namespace of sandboxed virtiofsd', async () => {
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const paths = harness.runPaths('virtiofsd-netns');
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );

      await handle.prepareProcess('virtiofsd-0', process.execPath, '/sock', '/source');
      await handle.captureProcess('virtiofsd-0', 5000);

      const record = JSON.parse(await fs.readFile(
        path.join(harness.temporaryRoot, 'pending-cleanup', 'virtiofsd-netns.json'),
        'utf8',
      )) as { processes: Record<string, { identity: { networkNamespace: string } }> };
      expect(record.processes['virtiofsd-0'].identity.networkNamespace).toBe('net:[5000]');
    });
  });

  describe('network and mount capture', () => {
    it('commits the agent-enclave network and only its own resources to durable cleanup', async () => {
      const paths = harness.runPaths('enclave-cleanup');
      const plan = createMicrovmNetworkPlan(paths.runId, {
        infrastructureBridge: 'br-aaaaaaaaaaaa',
        enableApiProxy: false,
        enclaveAgent: { apiProxyPort: 10002, githubDataPlane: false },
        tapOwnerUid: 2001,
        tapOwnerGid: 2002,
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.createPending(paths, process.execPath, '/usr/bin/ip');
      await handle.captureNetworkPlan(plan);
      const record = JSON.parse(await fs.readFile(
        path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
        'utf8',
      )) as { network: { mode: string; infrastructureBridge: string; hostVethName: string } };
      expect(record.network).toMatchObject({
        mode: 'enclave-agent',
        infrastructureBridge: plan.infrastructureBridge,
        hostVethName: plan.hostVethName,
      });
      await expect(handle.complete()).resolves.toBeUndefined();
      await expect(handle.complete()).resolves.toBeUndefined();
    });

    it.each([
      ['non-array output', '{}', /Unexpected interface inspection/],
      ['wrong interface', '[{"ifname":"other","ifindex":12}]', /Invalid interface inspection/],
      ['non-integer index', '[{"ifname":"host","ifindex":"12"}]', /Invalid interface inspection/],
    ])('rejects %s from kernel interface inspection', async (_label, stdout, expected) => {
      const paths = harness.runPaths('bad-interface');
      const plan = harness.networkPlan(paths.runId);
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({
        run: jest.fn(async () => ({ exitCode: 0, stdout, stderr: '' })),
      }));
      const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');

      await expect(handle.captureNetworkResource('hostVeth')).rejects.toThrow(expected);
    });

    it('propagates kernel interface inspection failures', async () => {
      const paths = harness.runPaths('interface-inspection-error');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({
        run: jest.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'netlink denied' })),
      }));
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );

      await expect(handle.captureNetworkResource('hostVeth')).rejects.toThrow(/netlink denied/);
    });

    it('rejects malformed mountinfo and decodes valid escaped mount paths', async () => {
      const basePaths = harness.runPaths('mount-parser');
      const paths = {
        ...basePaths,
        virtiofsdShareDirectory: path.join(
          harness.temporaryRoot,
          'virtiofsd with space',
          basePaths.runId,
        ),
      };
      await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      harness.state.mountInfo = 'not mountinfo\n';
      await expect(handle.captureVirtiofsdResources()).rejects.toThrow(
        /Malformed \/proc\/self\/mountinfo entry/,
      );

      const escaped = paths.virtiofsdShareDirectory.replace(/ /g, '\\040');
      harness.state.mountInfo = `123 1 8:1 /source ${escaped} rw - ext4 /dev/sda1 rw\n`;
      await expect(handle.captureVirtiofsdResources()).resolves.toBeUndefined();
    });
  });
});
