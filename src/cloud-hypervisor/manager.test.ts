import type { ExecaChildProcess } from 'execa';
import { PassThrough } from 'stream';
import type {
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
} from '../microvm/network';
import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type { MicrovmRootfsPreparer } from '../microvm/rootfs';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorApiClient } from './api-client';
import type { CloudHypervisorCgroup } from './launcher';
import type { VirtiofsdManager } from './virtiofsd';
import type { CloudHypervisorDirectoryExport } from './exports';
import {
  CloudHypervisorManager,
  buildSupervisorBootArgs,
  cloudHypervisorManagerTestHelpers,
  createCloudHypervisorRunPaths,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorManagerNetworkConfig,
} from './manager';
import type { CloudHypervisorHostToolPaths } from './preflight';

const hostTools: CloudHypervisorHostToolPaths = {
  ip: '/usr/bin/ip',
  nft: '/usr/sbin/nft',
  sysctl: '/usr/sbin/sysctl',
  mke2fs: '/usr/sbin/mke2fs',
  debugfs: '/usr/sbin/debugfs',
  e2fsck: '/usr/sbin/e2fsck',
  rsync: '/usr/bin/rsync',
  mount: '/usr/bin/mount',
  umount: '/usr/bin/umount',
  setpriv: '/usr/bin/setpriv',
};

const exportsConfig = [
  { tag: 'workspace', source: '/workspace', target: '/workspace', mode: 'rw' as const },
];

function rootfsPreparerMock(): MicrovmRootfsPreparer {
  return {
    rootfsImagePath: '/prepared/rootfs.ext4',
    prepare: jest.fn().mockResolvedValue('/prepared/rootfs.ext4'),
  } as unknown as MicrovmRootfsPreparer;
}

function virtiofsdManagerMock(): VirtiofsdManager {
  return {
    start: jest.fn(async (exports: readonly CloudHypervisorDirectoryExport[]) => exports.map((item, index) => ({
      export: item,
      socketPath: `/run/virtiofs-${index}.sock`,
      logPath: `/run/virtiofs-${index}.log`,
    }))),
    stop: jest.fn().mockResolvedValue(undefined),
  } as unknown as VirtiofsdManager;
}

function config(overrides: Partial<CloudHypervisorOptions> = {}): CloudHypervisorOptions {
  return {
    previewEnabled: true,
    cloudHypervisorBinary: '/opt/cloud-hypervisor',
    kernelPath: '/opt/vmlinux',
    rootfsPath: '/opt/rootfs.ext4',
    supervisorPath: '/opt/awf-supervisor',
    vcpuCount: 2,
    memoryMib: 512,
    apiTimeoutMs: 1,
    ...overrides,
  };
}

function processMock(): ExecaChildProcess<string> {
  const child = Promise.resolve({ exitCode: 0 }) as unknown as ExecaChildProcess<string>;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 4242,
    kill: jest.fn(() => {
      Object.assign(child, { exitCode: 0, killed: true });
      return true;
    }),
  });
  return child;
}

function networkConfig(
  overrides: Partial<CloudHypervisorManagerNetworkConfig> = {},
): CloudHypervisorManagerNetworkConfig {
  return {
    infrastructureBridge: 'awfbr0',
    enableApiProxy: true,
    apiProxyIp: '172.30.0.30',
    ...overrides,
  };
}

function guestConfig() {
  return {
    exports: exportsConfig,
    supervisorBinaryPath: '/opt/awf-supervisor',
    supervisorSha256: 'a'.repeat(64),
  };
}

function networkLifecycle(plan: MicrovmNetworkPlan): MicrovmNetworkLifecycle {
  return {
    plan,
    setup: jest.fn().mockResolvedValue(plan),
    cleanup: jest.fn().mockResolvedValue(undefined),
  };
}

function cgroupMock(): CloudHypervisorCgroup {
  return {
    cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/run',
    setup: jest.fn().mockResolvedValue(undefined),
    assign: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudHypervisorCgroup;
}

function dependencies(
  overrides: Partial<CloudHypervisorManagerDependencies> = {},
): CloudHypervisorManagerDependencies {
  const client = {
    ping: jest.fn().mockResolvedValue({ version: '53.0' }),
    vmCreate: jest.fn().mockResolvedValue(undefined),
    vmBoot: jest.fn().mockResolvedValue(undefined),
    vmInfo: jest.fn().mockResolvedValue({ state: 'Running' }),
    vmCounters: jest.fn().mockResolvedValue({ net0: { rx_bytes: 0 } }),
    vmShutdown: jest.fn().mockResolvedValue(undefined),
    vmmShutdown: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudHypervisorApiClient;
  return {
    preflight: jest.fn().mockResolvedValue({
      version: '53.0',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      virtiofsdBinary: '/opt/virtiofsd',
      kernelPath: '/opt/vmlinux',
      rootfsPath: '/opt/rootfs.ext4',
      tools: hostTools,
      supervisorPath: '/opt/awf-supervisor',
      cgroupVersion: 2,
      kvmGid: 978,
    }),
    launch: jest.fn().mockReturnValue(processMock()),
    mkdir: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    chown: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFileTail: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    access: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
    createClient: jest.fn().mockReturnValue(client),
    createNetwork: jest.fn((plan) => networkLifecycle(plan)),
    createRootfsPreparer: jest.fn(() => rootfsPreparerMock()),
    createVirtiofsdManager: jest.fn(() => virtiofsdManagerMock()),
    createVsockClient: jest.fn(),
    createCgroup: jest.fn(() => cgroupMock()),
    resolveIdentity: jest.fn().mockReturnValue({ uid: 1000, gid: 1000 }),
    ...overrides,
  };
}

describe('CloudHypervisorManager', () => {
  it('constructs the default host adapters and non-root identity', async () => {
    const defaults = cloudHypervisorManagerTestHelpers.defaultDependencies;
    const child = defaults.launch(process.execPath, ['-e', ''], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin' },
      extendEnv: false,
    });
    await expect(child).resolves.toMatchObject({ exitCode: 0 });
    await expect(defaults.sleep(0)).resolves.toBeUndefined();
    expect(defaults.createClient('/tmp/api.socket', 100)).toBeDefined();
    expect(defaults.createNetwork({} as MicrovmNetworkPlan, hostTools)).toBeDefined();
    expect(defaults.createRootfsPreparer({
      runDirectory: '/work/rootfs',
      baseRootfsPath: '/opt/rootfs',
      supervisorBinaryPath: '/opt/supervisor',
      supervisorSha256: 'a'.repeat(64),
    }, hostTools)).toBeDefined();
    expect(defaults.createVirtiofsdManager(
      '/opt/virtiofsd',
      '/run/awf',
      '/run/awf-shares',
      { uid: 1000, gid: 1000 },
      cgroupMock(),
      { mount: hostTools.mount, umount: hostTools.umount },
    )).toBeDefined();
    expect(defaults.createVsockClient('/tmp/vsock.socket', 52, 100)).toBeDefined();
    expect(defaults.createCgroup('/sys/fs/cgroup/awf/run', { memoryMib: 512, vcpuCount: 2 })).toBeDefined();

    const originalSudoUid = process.env.SUDO_UID;
    const originalSudoGid = process.env.SUDO_GID;
    const uidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
    const gidSpy = jest.spyOn(process, 'getgid').mockReturnValue(0);
    try {
      process.env.SUDO_UID = '2001';
      process.env.SUDO_GID = '2002';
      expect(cloudHypervisorManagerTestHelpers.resolveCloudHypervisorIdentity()).toEqual({
        uid: 2001,
        gid: 2002,
      });

      delete process.env.SUDO_UID;
      delete process.env.SUDO_GID;
      expect(cloudHypervisorManagerTestHelpers.resolveCloudHypervisorIdentity)
        .toThrow(/non-root target uid\/gid/);
    } finally {
      uidSpy.mockRestore();
      gidSpy.mockRestore();
      if (originalSudoUid === undefined) delete process.env.SUDO_UID;
      else process.env.SUDO_UID = originalSudoUid;
      if (originalSudoGid === undefined) delete process.env.SUDO_GID;
      else process.env.SUDO_GID = originalSudoGid;
    }
  });

  it('constructs unique, contained run paths outside workDir', () => {
    const first = createCloudHypervisorRunPaths('/opt/cloud-hypervisor');
    const second = createCloudHypervisorRunPaths('/opt/cloud-hypervisor');
    expect(first.runId).not.toBe(second.runId);
    expect(first.runDirectory).toContain('/run/awf-cloud-hypervisor/cloud-hypervisor/');
    expect(first.cgroupPath).toContain('/sys/fs/cgroup/awf-cloud-hypervisor/');
    expect(() => createCloudHypervisorRunPaths(
      '/opt/cloud-hypervisor',
      '../escape',
    )).toThrow(/Unsafe microVM run id/);
  });

  it('launches via the secure launcher and creates/boots the VM over the API', async () => {
    const deps = dependencies();
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'run-1',
      networkConfig(),
    );
    const client = await manager.start();

    expect(deps.launch).toHaveBeenCalledWith(
      '/usr/bin/ip',
      expect.arrayContaining([
        'netns', 'exec', expect.stringMatching(/^awffc-/),
        '/usr/bin/setpriv',
        '--reuid=1000',
        '--regid=1000',
        '--groups=978',
      ]),
      expect.objectContaining({
        reject: false,
        extendEnv: false,
        env: { PATH: expect.stringContaining('/bin') },
      }),
    );
    const launchEnv = (deps.launch as jest.Mock).mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(Object.keys(launchEnv)).toEqual(['PATH']);
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      cpus: { boot_vcpus: 2, max_vcpus: 2 },
      memory: { size: 512 * 1024 * 1024 },
      payload: expect.objectContaining({ kernel: expect.stringContaining('/kernel') }),
      landlock_enable: true,
    }));
    expect(client.vmCreate).not.toHaveBeenCalledWith(expect.objectContaining({ vsock: expect.anything() }));
    expect(client.ping).toHaveBeenCalledTimes(1);
    // Regression test: Cloud Hypervisor defaults all three offloads to
    // enabled, but this network path is a fully-software bridge/veth/tap
    // chain with no real NIC downstream to finish partially-offloaded
    // frames. Live-KVM validation showed guest-to-Squid forward traffic
    // being accepted by nftables (visible via its per-rule counters) but
    // the return path never matching the established/related accept
    // rule -- disabling all three offloads removes offload-related
    // packet malformation as a possible cause, explicitly rather than
    // relying on Cloud Hypervisor's own defaults.
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      net: [expect.objectContaining({
        offload_tso: false,
        offload_ufo: false,
        offload_csum: false,
      })],
    }));
    expect(deps.createCgroup).toHaveBeenCalledWith(
      expect.stringContaining('awf-cloud-hypervisor/run-1'),
      { memoryMib: 512, vcpuCount: 2 },
    );
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.setup).toHaveBeenCalledTimes(1);
    expect(cgroup.assign).toHaveBeenCalledWith(4242);
    // Private run directory: ancestor levels stay traversable-only (0711,
    // root-owned); only the leaf is chowned to the non-root identity.
    expect(deps.mkdir).toHaveBeenCalledWith('/run/awf-cloud-hypervisor', { recursive: true, mode: 0o711 });
    expect(deps.chmod).toHaveBeenCalledWith('/run/awf-cloud-hypervisor', 0o711);
    expect(deps.mkdir).toHaveBeenCalledWith('/run/awf-cloud-hypervisor/cloud-hypervisor', { recursive: true, mode: 0o711 });
    expect(deps.chmod).toHaveBeenCalledWith('/run/awf-cloud-hypervisor/cloud-hypervisor', 0o711);
    expect(deps.mkdir).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/cloud-hypervisor/run-1',
      { recursive: true, mode: 0o700 },
    );
    expect(deps.chown).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/cloud-hypervisor/run-1',
      1000,
      1000,
    );
    expect(deps.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        infrastructureBridge: 'awfbr0',
        tapOwnerUid: 1000,
        tapOwnerGid: 1000,
        tapVnetHdr: true,
      }),
      hostTools,
    );
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.setup).toHaveBeenCalledTimes(1);
  });

  it('terminates the partial process and removes its run directory on readiness failure', async () => {
    const child = processMock();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn(async () => new Promise((resolve) => setTimeout(resolve, 2))),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'partial',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow(/API socket was not ready/);
    expect(child.kill).toHaveBeenCalledWith(
      'SIGTERM',
      { forceKillAfterTimeout: 2_000 },
    );
    expect(deps.rm).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/cloud-hypervisor/partial',
      { recursive: true, force: true },
    );
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses to launch without host-side network enforcement', async () => {
    const deps = dependencies();
    const manager = new CloudHypervisorManager(config(), '/tmp/awf', deps, 'unsafe');

    await expect(manager.start()).rejects.toThrow(/unfiltered microVM/);
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('cleans up the network and cgroup before removing the run directory', async () => {
    const order: string[] = [];
    const deps = dependencies({
      createNetwork: jest.fn((plan) => ({
        plan,
        setup: jest.fn().mockResolvedValue(plan),
        cleanup: jest.fn(async () => {
          order.push('network');
        }),
      })),
      createCgroup: jest.fn(() => ({
        cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/cleanup',
        setup: jest.fn().mockResolvedValue(undefined),
        assign: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn(async () => {
          order.push('cgroup');
        }),
      } as unknown as CloudHypervisorCgroup)),
      rm: jest.fn(async () => {
        order.push('run-directory');
      }),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'cleanup',
      networkConfig(),
    );

    await manager.start();
    await manager.stop();

    expect(order).toEqual(['network', 'cgroup', 'run-directory']);
  });

  it('configures one rootfs disk and virtio-fs devices, then stops daemons after the VMM', async () => {
    const order: string[] = [];
    const child = processMock();
    const virtiofsd = virtiofsdManagerMock();
    (virtiofsd.stop as jest.Mock).mockImplementation(async () => {
      order.push('virtiofsd');
      expect(child.exitCode).toBe(0);
    });
    const guestClient = {
      connect: jest.fn().mockResolvedValue({
        version: 1,
        type: 'ready',
        requestId: 'control',
        capabilities: { stdin: true, tty: false, resize: false },
      }),
      execute: jest.fn().mockResolvedValue({
        requestId: 'command',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'guest',
      networkConfig({
        controlPeers: [{ ip: '172.30.0.60', ports: [8080] }],
        hostAliases: { 'awmg-mcpg': '172.30.0.60' },
      }),
      guestConfig(),
    );

    const client = await manager.start();
    expect(deps.createRootfsPreparer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostAliases: {
          'api-proxy': '172.30.0.30',
          'awmg-mcpg': '172.30.0.60',
        },
      }),
      hostTools,
    );
    expect(deps.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedEndpoints: expect.arrayContaining([
          { name: 'control-peer', ip: '172.30.0.60', port: 8080 },
        ]),
      }),
      hostTools,
    );
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ cmdline: expect.stringContaining('init=/usr/sbin/awf-supervisor') }),
      memory: expect.objectContaining({ shared: true }),
      disks: [expect.objectContaining({ id: 'rootfs', image_type: 'Raw', readonly: false })],
      fs: [expect.objectContaining({
        tag: 'workspace',
        socket: '/run/virtiofs-0.sock',
        num_queues: 1,
        queue_size: 1024,
      })],
      vsock: expect.objectContaining({ cid: 3 }),
    }));
    const vmConfig = (client.vmCreate as jest.Mock).mock.calls[0][0];
    expect(vmConfig.landlock_rules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/workspace' }),
    ]));
    await manager.startInstance();
    expect(client.vmBoot).toHaveBeenCalledTimes(1);
    expect(deps.createVsockClient).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/cloud-hypervisor/guest/awf-vsock.socket'),
      52,
      1,
    );
    await expect(manager.execute({
      requestId: 'command',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));
    await manager.stop();

    expect(guestClient.shutdown).toHaveBeenCalledTimes(1);
    expect(client.vmShutdown).toHaveBeenCalledTimes(1);
    expect(client.vmmShutdown).toHaveBeenCalledTimes(1);
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['virtiofsd']);
  });

  it('preserves the cgroup and run directory when virtiofsd cannot be reaped', async () => {
    const virtiofsd = virtiofsdManagerMock();
    (virtiofsd.stop as jest.Mock).mockRejectedValue(new Error('virtiofsd did not exit'));
    const deps = dependencies({
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'virtiofsd-stuck',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    (deps.rm as jest.Mock).mockClear();

    await expect(manager.stop()).rejects.toThrow(
      /stopped before cgroup\/run-directory removal.*virtiofsd did not exit/,
    );

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(cgroup.cleanup).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('retries the vsock connect on the guest-not-ready-yet boot race, with a fresh client each attempt', async () => {
    // Regression test: Cloud Hypervisor's vsock-over-UDS multiplexer closes
    // the host-facing connection immediately if the guest isn't yet
    // listening on the target port, surfacing as "guest disconnected
    // before readiness" even though vm.boot() itself succeeded — a real
    // host/guest boot-timing race, not a fatal error. startInstance() must
    // retry with a fresh client (MicrovmVsockClient cannot reconnect a
    // socket that already closed) until the guest is ready.
    const readyFrame = {
      version: 1,
      type: 'ready' as const,
      requestId: 'control',
      capabilities: { stdin: true, tty: false, resize: false },
    };
    const failingClient = {
      connect: jest.fn().mockRejectedValue(new Error('guest disconnected before readiness')),
      destroy: jest.fn(),
    };
    const succeedingClient = {
      connect: jest.fn().mockResolvedValue(readyFrame),
      execute: jest.fn().mockResolvedValue({
        requestId: 'command', exitCode: 0, signal: null, timedOut: false,
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    };
    const createVsockClient = jest.fn()
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(succeedingClient);
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(processMock()),
      createRootfsPreparer: jest.fn().mockReturnValue(rootfsPreparerMock()),
      createVsockClient,
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'retry-guest',
      networkConfig(),
      guestConfig(),
    );

    await manager.start();
    await manager.startInstance();

    expect(createVsockClient).toHaveBeenCalledTimes(3);
    expect(failingClient.destroy).toHaveBeenCalledTimes(2);
    expect(succeedingClient.connect).toHaveBeenCalledTimes(1);
  });

  it('tolerates guest boot taking well beyond the old 20-second budget under slow (nested-virtualization) conditions', async () => {
    // Regression test: live-KVM validation on GitHub-hosted runners showed
    // guest boot legitimately taking far longer than 20 seconds of real
    // wall-clock time under nested virtualization (severe vCPU scheduling
    // contention advanced the guest's own boot-log clock far slower than
    // host wall-clock time). The vsock connect-retry budget was increased
    // from 20s to 90s so a merely-slow (not hung/crashed) guest isn't
    // aborted early. Simulate ~21s of wall-clock time elapsing per failed
    // connect attempt and assert the retry loop survives several such
    // cycles — which the old 20s budget could not have tolerated even
    // once — before finally giving up once the 90s budget is exhausted.
    const startedAtMs = 1_000_000;
    let elapsedMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => startedAtMs + elapsedMs);
    const failingClient = {
      connect: jest.fn().mockImplementation(() => {
        elapsedMs += 21_000;
        return Promise.reject(new Error('guest disconnected before readiness'));
      }),
      destroy: jest.fn(),
    };
    const createVsockClient = jest.fn().mockReturnValue(failingClient);
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(processMock()),
      createRootfsPreparer: jest.fn().mockReturnValue(rootfsPreparerMock()),
      createVsockClient,
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'retry-guest-slow-boot',
      networkConfig(),
      guestConfig(),
    );

    try {
      await manager.start();
      await expect(manager.startInstance()).rejects.toThrow(
        'guest disconnected before readiness',
      );

      // A 20s budget would have given up after a single ~21s attempt; the
      // 90s budget must retry at least four times (~84s simulated) before
      // exhausting.
      expect(createVsockClient.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  it('delegates guest cancellation, stdin, and resize only after readiness', async () => {
    const cold = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      dependencies(),
      'cold-guest',
      networkConfig(),
    );
    await expect(cold.cancel()).rejects.toThrow(/supervisor is not ready/);
    await expect(cold.writeStdin(Buffer.from('input'))).rejects.toThrow(/supervisor is not ready/);
    await expect(cold.endStdin()).rejects.toThrow(/supervisor is not ready/);
    await expect(cold.resize(80, 24)).rejects.toThrow(/supervisor is not ready/);

    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
      writeStdin: jest.fn().mockResolvedValue(undefined),
      endStdin: jest.fn().mockResolvedValue(undefined),
      resize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'ready-guest',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();
    await manager.cancel('test', 'request');
    await manager.writeStdin(Buffer.from('input'), 'request');
    await manager.endStdin('request');
    await manager.resize(80, 24, 'request');

    expect(guestClient.cancel).toHaveBeenCalledWith('test', 'request');
    expect(guestClient.writeStdin).toHaveBeenCalledWith(Buffer.from('input'), 'request');
    expect(guestClient.endStdin).toHaveBeenCalledWith('request');
    expect(guestClient.resize).toHaveBeenCalledWith(80, 24, 'request');
    await manager.stop();
  });

  it('quiesces and stops virtiofsd while preserving the run directory and network in keep mode', async () => {
    const child = processMock();
    const virtiofsd = virtiofsdManagerMock();
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();

    await manager.stop({ preserve: true });

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(deps.rm).toHaveBeenCalledWith(
      '/prepared',
      { recursive: true, force: true },
    );
    expect(deps.rm).not.toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/'),
      expect.anything(),
    );
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
  });

  it('invokes a beforeCleanup hook after process termination but before run-directory removal', async () => {
    // Regression test: Cloud Hypervisor does not flush buffered guest
    // serial console output until its process actually exits, so
    // diagnostics collection must happen after process termination is
    // confirmed but before stop() removes the run directory those
    // diagnostic files live in. Discovered via live-KVM validation: a
    // guest boot failure produced a completely empty serial console log
    // when diagnostics were collected any earlier (e.g. before
    // vmm.shutdown()/process termination).
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();

    const beforeCleanup = jest.fn(async () => {});

    await manager.stop({ beforeCleanup });

    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/'),
      { recursive: true, force: true },
    );
    // beforeCleanup must run strictly before the run-directory removal
    // call (deps.rm), i.e. after process termination is confirmed but
    // before diagnostic files are deleted.
    const runRmIndex = (deps.rm as jest.Mock).mock.calls.findIndex(
      ([target]) => String(target).startsWith('/run/awf-cloud-hypervisor/'),
    );
    const rmCallOrder = (deps.rm as jest.Mock).mock.invocationCallOrder[runRmIndex];
    expect(beforeCleanup.mock.invocationCallOrder[0]).toBeLessThan(rmCallOrder);
  });

  it('propagates a beforeCleanup hook failure alongside other stop() errors', async () => {
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();

    await expect(
      manager.stop({
        beforeCleanup: async () => {
          throw new Error('diagnostics write failed');
        },
      }),
    ).rejects.toThrow(/diagnostics write failed/);
    // Run-directory removal must still proceed even if beforeCleanup fails.
    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/'),
      { recursive: true, force: true },
    );
  });

  it('builds explicit supervisor boot cmdline with PCI-required root/interface naming', () => {
    const args = buildSupervisorBootArgs({
      runId: 'run',
      namespaceName: 'ns',
      netnsPath: '/var/run/netns/ns',
      nftTableName: 'table',
      infrastructureBridge: 'awfbr0',
      hostVethName: 'host',
      namespaceVethName: 'namespace',
      tapName: 'tap',
      infrastructureIp: '172.30.0.20',
      infrastructureCidr: '172.30.0.0/24',
      hostGatewayIp: '172.30.0.1',
      guestSubnet: '100.64.0.0/30',
      guestIp: '100.64.0.2',
      guestGatewayIp: '100.64.0.1',
      guestPrefixLength: 30,
      guestMac: '02:00:00:00:00:01',
      tapOwnerUid: 1000,
      tapOwnerGid: 1000,
      tapVnetHdr: true,
      allowedEndpoints: [],
      networkInterface: { iface_id: 'eth0', host_dev_name: 'tap' },
    }, guestConfig());
    expect(args).toContain('root=/dev/vda');
    expect(args).toContain('panic=0');
    expect(args).not.toContain('panic=1');
    expect(args).toContain('awf.guest-ip=100.64.0.2');
    expect(args).toContain('awf.guest-gateway=100.64.0.1');
    expect(args).not.toContain('awf.workspace-device=');
    expect(args).toContain('awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw');
    expect(args).toContain('net.ifnames=0');
    expect(args).not.toContain('pci=off');
    expect(args).not.toContain('8.8.8.8');
  });

  it('retains virtiofsd and network until process termination is confirmed', async () => {
    const child = Promise.resolve({ exitCode: null }) as unknown as ExecaChildProcess<string>;
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      killed: false,
      pid: 9,
      kill: jest.fn(() => {
        Object.assign(child, { killed: true });
        return true;
      }),
    });
    const virtiofsd = virtiofsdManagerMock();
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'termination',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();

    await expect(manager.stop()).rejects.toThrow(/stopped before network\/run-directory removal/);
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(deps.rm).not.toHaveBeenCalled();

    Object.assign(child, { exitCode: 0 });
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
  });

  it('waits briefly for natural VM exit after guest shutdown before sending SIGTERM', async () => {
    const child = processMock();
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    let sleepCalls = 0;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
      sleep: jest.fn(async () => {
        sleepCalls += 1;
        if (sleepCalls === 3) Object.assign(child, { exitCode: 0 });
      }),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'natural-exit',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();
    await manager.stop();
    expect(child.kill).not.toHaveBeenCalled();
    expect(sleepCalls).toBeGreaterThan(0);
  });

  it('rolls back the network and cgroup when vm.create fails', async () => {
    const client = {
      ping: jest.fn().mockResolvedValue({ version: '53.0' }),
      vmCreate: jest.fn().mockRejectedValue(new Error('invalid disk path')),
      vmBoot: jest.fn().mockResolvedValue(undefined),
      vmInfo: jest.fn().mockResolvedValue({ state: 'Created' }),
      vmCounters: jest.fn().mockResolvedValue({}),
      vmShutdown: jest.fn().mockResolvedValue(undefined),
      vmmShutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as CloudHypervisorApiClient;
    const deps = dependencies({
      createClient: jest.fn().mockReturnValue(client),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'create-failure',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow('invalid disk path');

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalled();
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
  });

  it('fails fast when Cloud Hypervisor exits by signal before API readiness', async () => {
    const child = processMock();
    Object.assign(child, { signalCode: 'SIGKILL', kill: jest.fn() });
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    const manager = new CloudHypervisorManager(
      config({ apiTimeoutMs: 2000 }),
      '/tmp/awf',
      deps,
      'signal',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow(
      /exited before API readiness with code null and signal SIGKILL/,
    );
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('collects bounded diagnostics including VM counters', async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 128, 0x61);
    const child = processMock();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      readFileTail: jest.fn().mockImplementation((_source: string, maxBytes: number) =>
        Promise.resolve(oversized.subarray(oversized.length - maxBytes)),
      ),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'diagnostics',
      networkConfig(),
    );

    const client = await manager.start();
    stdout.write(oversized);
    stderr.write('launcher error');
    await manager.startInstance();
    await manager.collectDiagnostics('/tmp/diagnostics');

    expect(client.vmCounters).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/launcher-stdout.log',
      expect.objectContaining({ length: 1024 * 1024 }),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/launcher-stderr.log',
      Buffer.from('launcher error'),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/counters.json',
      expect.stringContaining('rx_bytes'),
      { mode: 0o600 },
    );
  });

  it('snapshots vm.info/vm.counters before any shutdown attempt, so collectDiagnostics() via beforeCleanup still has real data', async () => {
    // Regression test: vm.info/vm.counters require the Cloud Hypervisor
    // API socket to still be responsive. collectDiagnostics() usually
    // runs via stop()'s beforeCleanup hook -- deliberately placed *after*
    // process termination is confirmed (see that hook's own comment) so
    // buffered serial console output has been flushed. But by that point
    // the API socket is already closed (the process was just asked to
    // exit), so a live vmCounters()/vmInfo() call there would always
    // fail. stop() must snapshot both *before* it calls vmmShutdown(),
    // and collectDiagnostics() must prefer that snapshot over a live call
    // that can no longer succeed.
    const child = processMock();
    const deps = dependencies({ launch: jest.fn().mockReturnValue(child) });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'vm-info-snapshot', networkConfig(),
    );
    const client = await manager.start();
    await manager.startInstance();

    let diagnosticsRanWithLiveClient = false;
    await manager.stop({
      beforeCleanup: async () => {
        // Simulate collectDiagnostics() running here, as it does via the
        // real beforeCleanup wiring in cloud-hypervisor-runtime-backend.ts.
        await manager.collectDiagnostics('/tmp/diagnostics');
        diagnosticsRanWithLiveClient = true;
      },
    });

    expect(diagnosticsRanWithLiveClient).toBe(true);
    // vmCounters/vmInfo were called exactly once each: during stop()'s
    // pre-shutdown snapshot, not again (uselessly) from inside
    // collectDiagnostics() after the client reference is already cleared.
    expect(client.vmCounters).toHaveBeenCalledTimes(1);
    expect(client.vmInfo).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/counters.json',
      expect.stringContaining('rx_bytes'),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/vm-info.json',
      expect.not.stringMatching(/^null$/m),
      { mode: 0o600 },
    );
  });

  it('captures live network diagnostics (nft ruleset + interface counters) when the network lifecycle supports it', async () => {
    // Regression test: a live-KVM connectivity failure investigation found
    // that a bare probe exit code, and even the static network-plan.json,
    // weren't enough to determine whether packets were being dropped by
    // an nftables forward-chain rule or never reaching the tap at all.
    // collectDiagnostics() must capture this live state (via the
    // network lifecycle's optional captureDiagnostics()) while the
    // namespace still exists.
    const child = processMock();
    const captureDiagnostics = jest.fn()
      .mockResolvedValue('--- nft list ruleset ---\n(fake ruleset)\n');
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createNetwork: jest.fn((plan) => ({
        ...networkLifecycle(plan),
        captureDiagnostics,
      })),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'net-diagnostics', networkConfig(),
    );

    await manager.start();
    await manager.collectDiagnostics('/tmp/diagnostics');

    expect(captureDiagnostics).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/network-diagnostics.txt',
      '--- nft list ruleset ---\n(fake ruleset)\n\n',
      { mode: 0o600 },
    );
  });

  it('reports network diagnostics as unavailable when the lifecycle does not support capture, without throwing', async () => {
    const child = processMock();
    const deps = dependencies({ launch: jest.fn().mockReturnValue(child) });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'net-diagnostics-unset', networkConfig(),
    );

    await manager.start();
    await expect(manager.collectDiagnostics('/tmp/diagnostics')).resolves.toBeUndefined();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/network-diagnostics.txt',
      expect.stringContaining('network namespace not set up'),
      { mode: 0o600 },
    );
  });

  it('falls back to a capture-failed message rather than throwing when captureDiagnostics itself rejects', async () => {
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createNetwork: jest.fn((plan) => ({
        ...networkLifecycle(plan),
        captureDiagnostics: jest.fn().mockRejectedValue(new Error('ip netns exec failed')),
      })),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'net-diagnostics-fail', networkConfig(),
    );

    await manager.start();
    await expect(manager.collectDiagnostics('/tmp/diagnostics')).resolves.toBeUndefined();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/network-diagnostics.txt',
      expect.stringContaining('capture failed: ip netns exec failed'),
      { mode: 0o600 },
    );
  });
});
