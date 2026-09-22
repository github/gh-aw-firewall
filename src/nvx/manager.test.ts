import {
  createMicrovmNetworkPlan,
  type MicrovmNetworkLifecycle,
} from '../microvm/network';
import type { NvxCleanupHandle, NvxCleanupRegistry } from './cleanup-registry';
import { bindNvxNetworkPlan } from './runtime-lifecycle';
import {
  createDefaultNvxManagerDependencies,
  NvxManager,
  type NvxLaunchExecutor,
  type NvxManagerDependencies,
} from './manager';
import { DirectOpenvmmLaunchExecutor } from './launch-executor';
import type { NvxPreflightResult } from './preflight';

const RUN_ID = 'a'.repeat(32);

function harness(overrides: Partial<NvxManagerDependencies> = {}) {
  const order: string[] = [];
  const cleanupHandle: NvxCleanupHandle = {
    record: {} as never,
    captureArtifactSnapshot: jest.fn(async (_directory: string) => { order.push('record-snapshot'); }),
    prepareAccount: jest.fn(async (_name: string) => { order.push('record-account-pending'); }),
    captureIdentity: jest.fn(async (_identity) => { order.push('record-account-live'); }),
    prepareDeviceAcl: jest.fn(async (_identity) => { order.push('record-acl'); }),
    releaseDeviceAcl: jest.fn(async (_identity) => { order.push('release-acl'); }),
    captureNetworkPlan: jest.fn(async (_plan) => { order.push('record-network-plan'); }),
    captureNetworkResource: jest.fn(async (_resource) => { order.push('record-network-resource'); }),
    captureRunDirectory: jest.fn(async () => { order.push('record-run-directory'); }),
    captureCgroup: jest.fn(async () => { order.push('record-cgroup'); }),
    captureProcess: jest.fn(async (kind: string, pid: number) => {
      order.push(`record-${kind}`);
      return { pid } as never;
    }),
    captureMountNamespace: jest.fn(async (_inode: string) => { order.push('record-mount-namespace'); }),
    complete: jest.fn(async () => { order.push('record-complete'); }),
  };
  const cleanupRegistry = {
    reapPending: jest.fn(async (_tools) => { order.push('reap'); }),
    createPending: jest.fn(async (_runId: string, _ipPath?: string) => {
      order.push('record-create');
      return cleanupHandle;
    }),
  } satisfies NvxCleanupRegistry;
  const tools = Object.fromEntries([
    'bwrap', 'env', 'flock', 'getfacl', 'getent', 'gh', 'groupdel', 'id', 'ip',
    'iptables', 'mkfs.erofs', 'mke2fs', 'nft', 'setfacl',
    'setpriv', 'sysctl', 'useradd', 'userdel',
  ].map((name) => [name, `/usr/bin/${name}`])) as NvxPreflightResult['tools'];
  const snapshotDirectory = `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`;
  const preflightResult = {
    manifest: {} as never,
    snapshot: {
      directory: snapshotDirectory,
      openvmm: `${snapshotDirectory}/openvmm`,
      kernel: `${snapshotDirectory}/vmlinux`,
      initramfs: `${snapshotDirectory}/initramfs.cpio.gz`,
      manifestPath: `${snapshotDirectory}/manifest.json`,
      bundlePath: `${snapshotDirectory}/manifest.sigstore.json`,
    },
    tools,
  } satisfies NvxPreflightResult;
  const runDirectory = `/run/awf-nvx/runs/${RUN_ID}`;
  const filesystem = {
    runDirectory,
    manifestPath: `${runDirectory}/manifest.json`,
    sourceDateEpoch: 0,
    layers: [{
      role: 'distro' as const,
      path: `${runDirectory}/distro.erofs`,
      uuid: '11111111-1111-4111-8111-111111111111',
      sha256: '1'.repeat(64),
      sourceManifestSha256: '2'.repeat(64),
      sourceEntries: 1,
      excludedPaths: [],
    }],
    scratch: {
      path: `${runDirectory}/scratch.ext4`,
      uuid: '22222222-2222-4222-8222-222222222222',
      sizeBytes: 128 * 1024 * 1024,
      uid: 65534,
      gid: 65534,
    },
  };
  const identity = { name: `awfnvx-${'b'.repeat(20)}`, uid: 2001, gid: 2002 };
  const identityManager = {
    allocate: jest.fn(async () => {
      order.push('identity');
      await cleanupHandle.prepareAccount(identity.name);
      await cleanupHandle.captureIdentity(identity);
      return identity;
    }),
    withDeviceAccess: jest.fn(async (operation: () => Promise<unknown>) => {
      order.push('acl-enter');
      try { return await operation(); } finally { order.push('acl-exit'); }
    }),
    cleanup: jest.fn(async () => { order.push('identity-cleanup'); }),
  };
  const network = {
    plan: {} as never,
    setup: jest.fn(async () => {
      order.push('network-setup');
      await cleanupHandle.captureNetworkResource('netns');
      return {} as never;
    }),
    cleanup: jest.fn(async () => { order.push('network-cleanup'); }),
  } satisfies MicrovmNetworkLifecycle;
  const networkReservation = {
    plan: bindNvxNetworkPlan(
      RUN_ID,
      createMicrovmNetworkPlan(RUN_ID, {
        infrastructureBridge: 'awfbr0',
        enableApiProxy: false,
        tapOwnerUid: identity.uid,
        tapOwnerGid: identity.gid,
        tapVnetHdr: true,
      }, {
        resourceToken: '123456789abc',
        subnetIndex: 1,
        infrastructureIp: '172.30.0.21',
        reservationPath: '/run/awf-microvm-network/reservations/123456789abc.json',
      }),
    ),
    release: jest.fn(async () => { order.push('reservation-release'); }),
  };
  const cgroup = {
    setup: jest.fn(async () => { order.push('cgroup-setup'); }),
    assignProcessTree: jest.fn(async (_pids: readonly number[]) => { order.push('cgroup-assign'); }),
    cleanup: jest.fn(async () => { order.push('cgroup-cleanup'); }),
  };
  const filesystemBuilder = {
    prepare: jest.fn(async () => { order.push('filesystem'); return filesystem; }),
    cleanup: jest.fn(async () => { order.push('filesystem-cleanup'); }),
  };
  const launchExecutor: NvxLaunchExecutor = {
    execute: jest.fn(async ({ hooks }) => {
      order.push('launch');
      await hooks.launcherStarted(4100);
      await hooks.sandboxStarted(4200);
      await hooks.openvmmReady(4200, '4026533001');
      return {
        exitCode: 0,
        category: 'success' as const,
        signal: null,
        timedOut: false,
        rawStdoutTail: Buffer.alloc(0),
        rawStderrTail: Buffer.alloc(0),
      };
    }),
    terminate: jest.fn(async () => { order.push('terminate'); }),
  };
  const dependencies: NvxManagerDependencies = {
    preflight: jest.fn(async (_options, hooks) => {
      order.push('preflight');
      await hooks.beforeSnapshot(tools);
      await hooks.snapshotCreated(preflightResult.snapshot);
      return preflightResult;
    }),
    cleanupRegistry,
    createIdentity: jest.fn(() => identityManager as never),
    createFilesystem: jest.fn(() => filesystemBuilder as never),
    reserveNetwork: jest.fn(async () => networkReservation),
    createNetwork: jest.fn(() => network),
    createCgroup: jest.fn(() => cgroup as never),
    launchExecutor,
    verifyConfinement: jest.fn(async () => {
      order.push('verify');
      return {} as never;
    }),
    copyFile: jest.fn(async () => undefined),
    chmod: jest.fn(async () => undefined),
    chown: jest.fn(async () => undefined),
    rm: jest.fn(async () => { order.push('snapshot-cleanup'); }),
    ...overrides,
  };
  const manager = new NvxManager({
    runId: RUN_ID,
    preflight: {
      runId: RUN_ID,
      expectedReleaseTag: 'v0.0.0',
      manifestPath: '/artifacts/manifest.json',
      artifactManifestBundlePath: '/artifacts/manifest.sigstore.json',
      artifacts: {
        openvmm: '/artifacts/openvmm',
        kernel: '/artifacts/vmlinux',
        initramfs: '/artifacts/initramfs.cpio.gz',
      },
    },
    filesystem: { workDir: '/work', layers: [{ role: 'distro', sourcePath: '/rootfs' }] },
    execution: { entrypoint: '/bin/true' },
    network: { infrastructureBridge: 'awfbr0', enableApiProxy: false },
  }, dependencies);
  return {
    manager, dependencies, order, cleanupHandle, launchExecutor, network,
    cgroup, filesystemBuilder, identityManager,
  };
}

describe('NvxManager', () => {
  it('wires the production direct OpenVMM executor by default', () => {
    expect(createDefaultNvxManagerDependencies().launchExecutor)
      .toBeInstanceOf(DirectOpenvmmLaunchExecutor);
  });

  it('orders durable setup, launch hooks, verification, and reverse cleanup', async () => {
    const value = harness();
    await expect(value.manager.execute()).resolves.toMatchObject({ exitCode: 0 });
    expect(value.order.indexOf('reap')).toBeLessThan(value.order.indexOf('record-create'));
    expect(value.order.indexOf('record-create')).toBeLessThan(value.order.indexOf('record-snapshot'));
    expect(value.order.indexOf('record-launcher')).toBeLessThan(value.order.indexOf('cgroup-assign'));
    expect(value.cgroup.assignProcessTree).toHaveBeenNthCalledWith(1, [4100, 4200]);
    expect(value.order.indexOf('record-openvmm')).toBeLessThan(value.order.indexOf('verify'));
    expect(value.dependencies.copyFile).toHaveBeenCalledWith(
      '/etc/resolv.conf',
      `/run/awf-nvx/runs/${RUN_ID}/resolv.conf`,
      expect.any(Number),
    );
    expect(value.dependencies.chmod).toHaveBeenCalledWith(
      `/run/awf-nvx/runs/${RUN_ID}/resolv.conf`,
      0o444,
    );
    expect(value.order.slice(-7)).toEqual([
      'terminate',
      'cgroup-cleanup',
      'filesystem-cleanup',
      'network-cleanup',
      'identity-cleanup',
      'snapshot-cleanup',
      'record-complete',
    ]);
    expect(value.cleanupHandle.complete).toHaveBeenCalledTimes(1);
  });

  it('rolls back partial setup and retains the record when cleanup fails', async () => {
    const value = harness();
    value.network.setup = jest.fn(async () => {
      throw new Error('network setup failed');
    });
    value.identityManager.cleanup = jest.fn(async () => {
      throw new Error('identity cleanup failed');
    });
    await expect(value.manager.execute()).rejects.toThrow(
      /network setup failed.*cleanup also failed.*identity cleanup failed/,
    );
    expect(value.network.cleanup).toHaveBeenCalled();
    expect(value.cleanupHandle.complete).not.toHaveBeenCalled();
  });

  it('fails closed when launch fails and cleans the prepared run', async () => {
    const value = harness({
      launchExecutor: {
        execute: jest.fn(async () => { throw new Error('direct launch failed'); }),
      },
    });
    await expect(value.manager.execute()).rejects.toThrow('direct launch failed');
    expect(value.cleanupHandle.complete).toHaveBeenCalledTimes(1);
  });

  it('treats confinement verification failure as launch failure and cleans up', async () => {
    const value = harness({
      verifyConfinement: jest.fn(async () => {
        throw new Error('confinement mismatch');
      }),
    });
    await expect(value.manager.execute()).rejects.toThrow(/confinement mismatch/);
    expect(value.launchExecutor.terminate).toHaveBeenCalled();
    expect(value.cleanupHandle.complete).toHaveBeenCalledTimes(1);
  });

  it('rejects an executor that returns before readiness and confinement hooks', async () => {
    const value = harness({
      launchExecutor: {
        execute: jest.fn(async () => ({
          exitCode: 0,
          category: 'success' as const,
          signal: null,
          timedOut: false,
          rawStdoutTail: Buffer.alloc(0),
          rawStderrTail: Buffer.alloc(0),
        })),
      },
    });
    await expect(value.manager.execute()).rejects.toThrow(/required .* hooks/);
    expect(value.cleanupHandle.complete).toHaveBeenCalledTimes(1);
  });
});
