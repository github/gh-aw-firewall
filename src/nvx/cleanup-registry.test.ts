import { promises as fs } from 'fs';
import type { PathLike } from 'fs';
import * as path from 'path';
import {
  DurableNvxCleanupRegistry,
  type NvxCleanupRegistryDependencies,
  type NvxCleanupToolPaths,
} from './cleanup-registry';
import { NvxCleanupStore, type NvxCleanupStoreDependencies } from './cleanup-store';
import type { MicrovmNetworkPlan } from '../microvm/network';
import { createNvxRunLayout } from './run-layout';

const RUN_ID = 'c'.repeat(32);
const tools: NvxCleanupToolPaths = {
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/sbin/ip',
  iptables: '/usr/sbin/iptables',
  setfacl: '/usr/bin/setfacl',
  userdel: '/usr/sbin/userdel',
};

describe('DurableNvxCleanupRegistry', () => {
  let root: string;
  let ownerAlive: boolean;
  let run: jest.Mock;
  let registry: DurableNvxCleanupRegistry;
  let store: NvxCleanupStore;
  let withDeviceAclLock: jest.Mock;
  let capturedFiles: Map<string, { device: number; inode: number }>;

  beforeEach(async () => {
    root = path.join(process.cwd(), `.nvx-cleanup-test-${process.pid}-${Date.now()}`);
    ownerAlive = true;
    capturedFiles = new Map();
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      if (String(filePath) === '/dev/kvm') {
        return {
          dev: (options as { bigint?: boolean } | undefined)?.bigint ? 8n : 8,
          ino: (options as { bigint?: boolean } | undefined)?.bigint ? 10n : 10,
          uid: (options as { bigint?: boolean } | undefined)?.bigint ? 0n : 0,
        } as never;
      }
      const capturedFile = capturedFiles.get(String(filePath));
      if (capturedFile) {
        const bigint = (options as { bigint?: boolean } | undefined)?.bigint;
        return {
          dev: bigint ? BigInt(capturedFile.device) : capturedFile.device,
          ino: bigint ? BigInt(capturedFile.inode) : capturedFile.inode,
          uid: bigint ? 0n : 0,
        } as never;
      }
      const value = await fs.lstat(filePath, options as never);
      return Object.assign(value, {
        uid: (options as { bigint?: boolean } | undefined)?.bigint ? 0n : 0,
      });
    }) as typeof fs.lstat;
    const processIdentity = {
      pid: 4242,
      startTimeTicks: '1000',
      executable: '/usr/bin/node',
      executableDevice: '8',
      executableInode: '9',
      uid: 0,
      gid: 0,
      networkNamespace: 'net:[4026531840]',
    };
    const readFile: typeof fs.readFile = (async (filePath: PathLike, options?: unknown) => {
      const value = String(filePath);
      if (value === '/proc/4242/stat') {
        return `4242 (node) ${['S', ...Array(18).fill('0'), ownerAlive ? '1000' : '2000'].join(' ')}`;
      }
      if (value === '/proc/4242/status') {
        return 'Uid:\t0 0 0 0\nGid:\t0 0 0 0\n';
      }
      return fs.readFile(filePath, options as never);
    }) as typeof fs.readFile;
    const readlink: typeof fs.readlink = (async (filePath: PathLike) => {
      if (String(filePath) === '/proc/4242/exe') return '/usr/bin/node';
      if (String(filePath) === '/proc/4242/ns/net') return 'net:[4026531840]';
      return fs.readlink(filePath);
    }) as typeof fs.readlink;
    const stat: typeof fs.stat = (async (filePath: PathLike, options?: unknown) => {
      if (String(filePath) === '/proc/4242/exe') {
        return { dev: 8n, ino: 9n } as never;
      }
      return fs.stat(filePath, options as never);
    }) as typeof fs.stat;
    const processMatches = jest.fn(async (identity) =>
      ownerAlive && identity.pid === processIdentity.pid &&
      identity.startTimeTicks === processIdentity.startTimeTicks);
    store = new NvxCleanupStore({
      effectiveUid: 0,
      pid: 4242,
      lstat,
      processMatches,
    } satisfies Partial<NvxCleanupStoreDependencies>, root);
    run = jest.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
    withDeviceAclLock = jest.fn(async (operation: () => Promise<unknown>) => operation());
    const dependencies: NvxCleanupRegistryDependencies = {
      store,
      pid: 4242,
      lstat,
      stat,
      readFile,
      readlink,
      rm: fs.rm,
      rmdir: fs.rmdir,
      kill: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      withDeviceAclLock,
      run,
    };
    registry = new DurableNvxCleanupRegistry(dependencies);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates an atomic private pending record with a process owner identity', async () => {
    await registry.createPending(RUN_ID);
    const recordPath = path.join(root, `${RUN_ID}.json`);
    const record = await store.read(recordPath);
    expect(record.owner).toMatchObject({
      pid: 4242,
      startTimeTicks: '1000',
      executable: '/usr/bin/node',
    });
    expect(record.vmmIdentity).toBeUndefined();
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it('skips a live owner and reaps the same record after the owner becomes stale', async () => {
    await registry.createPending(RUN_ID);
    const recordPath = path.join(root, `${RUN_ID}.json`);
    await registry.reapPending(tools);
    await expect(fs.access(recordPath)).resolves.toBeUndefined();

    ownerAlive = false;
    await registry.reapPending(tools);
    await expect(fs.access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a stale record when pending account ownership is ambiguous', async () => {
    const handle = await registry.createPending(RUN_ID);
    await handle.prepareAccount(`awfnvx-${'d'.repeat(20)}`);
    ownerAlive = false;
    run.mockResolvedValue({ exitCode: 0, stdout: '23001\n', stderr: '' });

    await expect(registry.reapPending(tools)).rejects.toThrow(
      /unverified pending NVX account/,
    );
    await expect(fs.access(path.join(root, `${RUN_ID}.json`))).resolves.toBeUndefined();
  });

  it('reaps an exactly validated account left pending after useradd', async () => {
    const name = `awfnvx-${'d'.repeat(20)}`;
    const handle = await registry.createPending(RUN_ID);
    await handle.prepareAccount(name);
    ownerAlive = false;
    run.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'passwd') {
        return {
          exitCode: 0,
          stdout: `${name}:x:23001:23002:AWF NVX ${RUN_ID}:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (args[0] === 'group') {
        return { exitCode: 0, stdout: `${name}:x:23002:\n`, stderr: '' };
      }
      if (args[0] === '-G') {
        return { exitCode: 0, stdout: '23002\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(registry.reapPending(tools)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(tools.userdel, [name]);
    expect(run).toHaveBeenCalledWith(tools.groupdel, [name]);
  });

  it('serializes stale device ACL removal with live lifecycle mutations', async () => {
    const name = `awfnvx-${'d'.repeat(20)}`;
    const devicePath = '/dev/kvm';
    const handle = await registry.createPending(RUN_ID);
    await handle.prepareAccount(name);
    await handle.captureIdentity({ name, uid: 23001, gid: 23002 });
    await handle.prepareDeviceAcl({
      path: devicePath,
      device: '8',
      inode: '10',
      permissions: 'rw-',
      uid: 23001,
    });
    ownerAlive = false;
    run.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'passwd') {
        return {
          exitCode: 0,
          stdout: `${name}:x:23001:23002:AWF NVX ${RUN_ID}:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (args[0] === 'group') {
        return { exitCode: 0, stdout: `${name}:x:23002:\n`, stderr: '' };
      }
      if (args[0] === '-G') {
        return { exitCode: 0, stdout: '23002\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await registry.reapPending(tools);

    expect(withDeviceAclLock).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      tools.setfacl,
      ['--remove', 'user:23001', devicePath],
    );
  });

  it('allows only one concurrent cleanup claimant', async () => {
    const handle = await registry.createPending(RUN_ID);
    const recordPath = path.join(root, `${RUN_ID}.json`);
    const first = await store.claim(recordPath, handle.record.owner);
    expect(first).toBeDefined();
    const second = await store.claim(recordPath, handle.record.owner);
    expect(second).toBeUndefined();
    await first?.();
  });

  describe('cleanup handle guards', () => {
    const name = `awfnvx-${'d'.repeat(20)}`;

    it('rejects an artifact snapshot outside the run layout', async () => {
      const handle = await registry.createPending(RUN_ID);
      await expect(handle.captureArtifactSnapshot('/tmp/not-the-run-layout')).rejects.toThrow(
        /outside the run layout/,
      );
      expect(handle.record.stages.artifactSnapshotCreated).toBe(false);
    });

    it('rejects preparing the account twice', async () => {
      const handle = await registry.createPending(RUN_ID);
      await handle.prepareAccount(name);
      await expect(handle.prepareAccount(name)).rejects.toThrow(/already prepared/);
    });

    it('rejects an identity that does not match the pending account', async () => {
      const handle = await registry.createPending(RUN_ID);
      await expect(handle.captureIdentity({ name, uid: 1, gid: 1 })).rejects.toThrow(
        /does not match its pending identity/,
      );
      await handle.prepareAccount(name);
      await expect(
        handle.captureIdentity({ name: `awfnvx-${'e'.repeat(20)}`, uid: 1, gid: 1 }),
      ).rejects.toThrow(/does not match its pending identity/);
    });

    it('promotes a matching pending account to live', async () => {
      const handle = await registry.createPending(RUN_ID);
      await handle.prepareAccount(name);
      await handle.captureIdentity({ name, uid: 23001, gid: 23002 });
      expect(handle.record.vmmIdentity).toMatchObject({ state: 'live', name, uid: 23001 });
      expect(handle.record.stages.accountCreated).toBe(true);
    });

    it('tracks device ACLs without duplicates and clears the stage on release', async () => {
      const handle = await registry.createPending(RUN_ID);
      const acl = {
        path: '/dev/kvm' as const,
        device: '8',
        inode: '10',
        permissions: 'rw-' as const,
        uid: 23001,
      };
      await handle.prepareDeviceAcl(acl);
      await handle.prepareDeviceAcl(acl);
      expect(handle.record.resources.deviceAcls).toHaveLength(1);
      expect(handle.record.stages.deviceAclsGranted).toBe(true);
      await handle.releaseDeviceAcl(acl);
      await handle.releaseDeviceAcl(acl);
      expect(handle.record.resources.deviceAcls).toHaveLength(0);
      expect(handle.record.stages.deviceAclsGranted).toBe(false);
    });

    it('rejects a network plan that is not bound to the run', async () => {
      const handle = await registry.createPending(RUN_ID);
      await expect(
        handle.captureNetworkPlan({ runId: 'f'.repeat(32), namespaceName: 'other' } as never),
      ).rejects.toThrow(/not bound to the run/);
      await expect(
        handle.captureNetworkPlan({ runId: RUN_ID, namespaceName: 'other' } as never),
      ).rejects.toThrow(/not bound to the run/);
    });

    it('rejects capturing a network resource before a plan exists', async () => {
      const handle = await registry.createPending(RUN_ID);
      await expect(handle.captureNetworkResource('netns')).rejects.toThrow();
    });

    it('persists the network plan and all captured network resources', async () => {
      const ipPath = '/custom/sbin/ip';
      const handle = await registry.createPending(RUN_ID, ipPath);
      const layout = createNvxRunLayout(RUN_ID);
      const resourceToken = 'e'.repeat(12);
      const reservationPath =
        `/run/awf-microvm-network/reservations/${resourceToken}.json`;
      const plan: MicrovmNetworkPlan = {
        runId: RUN_ID,
        resourceToken,
        reservationPath,
        namespaceName: layout.networkNamespace,
        netnsPath: `/var/run/netns/${layout.networkNamespace}`,
        nftTableName: `awf_${RUN_ID}`,
        hostForwardRuleComment: `awf-microvm-${resourceToken}`,
        infrastructureBridge: 'awfbr0',
        hostVethName: 'awf-host0',
        namespaceVethName: 'awf-ns0',
        tapName: 'awf-tap0',
        infrastructureIp: '10.200.0.1',
        infrastructureCidr: '10.200.0.0/24',
        hostGatewayIp: '10.200.0.1',
        guestSubnet: '192.168.100.0/24',
        guestIp: '192.168.100.2',
        guestGatewayIp: '192.168.100.1',
        guestPrefixLength: 24,
        guestMac: '02:00:00:00:00:01',
        tapOwnerUid: 0,
        tapOwnerGid: 0,
        tapVnetHdr: false,
        allowedEndpoints: [],
        networkInterface: { iface_id: 'eth0', host_dev_name: 'awf-tap0' },
      };
      capturedFiles.set(reservationPath, { device: 8, inode: 11 });
      capturedFiles.set(plan.netnsPath, { device: 8, inode: 12 });
      await handle.captureNetworkPlan(plan);

      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        network: {
          resourceToken: plan.resourceToken,
          namespaceName: layout.networkNamespace,
          netnsPath: plan.netnsPath,
          hostVethName: plan.hostVethName,
          namespaceVethName: plan.namespaceVethName,
          tapName: plan.tapName,
          infrastructureBridge: plan.infrastructureBridge,
          hostForwardRuleComment: plan.hostForwardRuleComment,
        },
        resources: { networkReservation: { path: reservationPath, device: '8', inode: '11' } },
        stages: { networkCreated: false },
      });

      run.mockImplementation(async (_command: string, args: readonly string[]) => ({
        exitCode: 0,
        stdout: JSON.stringify([{ ifname: args[args.length - 1], ifindex: 17 }]),
        stderr: '',
      }));
      await handle.captureNetworkResource('netns');
      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        resources: {
          networkNamespace: { path: plan.netnsPath, device: '8', inode: '12' },
        },
        stages: { networkCreated: true },
      });

      await handle.captureNetworkResource('hostVeth');
      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        resources: { hostVeth: { name: plan.hostVethName, ifindex: 17 } },
      });
      await handle.captureNetworkResource('namespaceVeth');
      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        resources: {
          namespaceVeth: {
            name: plan.namespaceVethName,
            namespace: layout.networkNamespace,
            ifindex: 17,
          },
        },
      });
      await handle.captureNetworkResource('tap');
      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        resources: {
          tap: { name: plan.tapName, namespace: layout.networkNamespace, ifindex: 17 },
        },
      });
      expect(run.mock.calls).toEqual([
        [ipPath, ['-json', 'link', 'show', 'dev', plan.hostVethName]],
        [
          ipPath,
          [
            'netns', 'exec', layout.networkNamespace, ipPath,
            '-json', 'link', 'show', 'dev', plan.namespaceVethName,
          ],
        ],
        [
          ipPath,
          [
            'netns', 'exec', layout.networkNamespace, ipPath,
            '-json', 'link', 'show', 'dev', plan.tapName,
          ],
        ],
      ]);
    });

    it('persists run-directory and cgroup identities and their stage flags', async () => {
      const handle = await registry.createPending(RUN_ID);
      const layout = createNvxRunLayout(RUN_ID);
      capturedFiles.set(layout.runDirectory, { device: 8, inode: 21 });
      capturedFiles.set(layout.cgroupPath, { device: 8, inode: 22 });

      await handle.captureRunDirectory();
      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        resources: { runDirectory: { path: layout.runDirectory, device: '8', inode: '21' } },
        stages: { runDirectoryCreated: true },
      });
      await handle.captureCgroup();
      expect(await store.read(path.join(root, `${RUN_ID}.json`))).toMatchObject({
        resources: { cgroup: { path: layout.cgroupPath, device: '8', inode: '22' } },
        stages: { cgroupCreated: true },
      });
    });

    it('validates mount namespace inodes', async () => {
      const handle = await registry.createPending(RUN_ID);
      await expect(handle.captureMountNamespace('abc')).rejects.toThrow(/inode is invalid/);
      await expect(handle.captureMountNamespace('')).rejects.toThrow(/inode is invalid/);
      await handle.captureMountNamespace('4026531841');
      expect(handle.record.resources.mountNamespaceInode).toBe('4026531841');
    });

    it('removes the durable record on complete', async () => {
      const handle = await registry.createPending(RUN_ID);
      await handle.complete();
      await expect(fs.access(path.join(root, `${RUN_ID}.json`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('persists handle mutations and process stages on the same record', async () => {
      const handle = await registry.createPending(RUN_ID);
      const record = handle.record;
      const readRecord = () => store.read(path.join(root, `${RUN_ID}.json`));
      const updatedAt = '2000-01-01T00:00:00.000Z';
      record.updatedAt = updatedAt;
      await handle.prepareAccount(name);
      expect((await readRecord()).vmmIdentity).toEqual({ state: 'pending', name });
      expect(record.updatedAt).not.toBe(updatedAt);
      await handle.captureIdentity({ name, uid: 23001, gid: 23002 });
      expect((await readRecord()).stages.accountCreated).toBe(true);

      const launcher = await handle.captureProcess('launcher', 4242);
      expect((await readRecord()).resources.launcher).toEqual(launcher);
      expect((await readRecord()).stages.processStarted).toBe(true);
      const openvmm = await handle.captureProcess('openvmm', 4242);
      expect((await readRecord()).resources.openvmm).toEqual(openvmm);
      await handle.captureMountNamespace('4026531841');
      expect((await readRecord()).resources.mountNamespaceInode).toBe('4026531841');
      expect(handle.record).toBe(record);
    });
  });
});
