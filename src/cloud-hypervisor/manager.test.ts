import type { ExecaChildProcess } from 'execa';
import { PassThrough } from 'stream';
import type {
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
} from '../microvm/network';
import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type { MicrovmWorkspaceImage } from '../microvm/workspace';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorApiClient } from './api-client';
import type { CloudHypervisorCgroup } from './launcher';
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
  setpriv: '/usr/bin/setpriv',
};

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
    ...overrides,
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
    createWorkspaceImage: jest.fn(),
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
    expect(defaults.createWorkspaceImage({
      runId: 'adapter-test',
      workDir: '/tmp/awf',
      workspacePath: '/workspace',
      homePath: '/home/runner',
      baseRootfsPath: '/opt/rootfs',
      supervisorBinaryPath: '/opt/supervisor',
      supervisorSha256: 'a'.repeat(64),
      uid: 1000,
      gid: 1000,
    }, hostTools)).toBeDefined();
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

  it('configures the workspace disk and vsock, then extracts only after VM termination', async () => {
    const order: string[] = [];
    const child = processMock();
    const workspace = {
      prepare: jest.fn().mockResolvedValue({
        workspaceImagePath: '/tmp/prepared-workspace.ext4',
        rootfsImagePath: '/tmp/prepared-rootfs.ext4',
        imageBytes: 1024,
        originalManifest: new Map(),
      }),
      extractAfterStop: jest.fn(async () => {
        order.push('extract');
        expect(child.exitCode).toBe(0);
      }),
      cleanup: jest.fn().mockResolvedValue(undefined),
    } as unknown as MicrovmWorkspaceImage;
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
      createWorkspaceImage: jest.fn().mockReturnValue(workspace),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'guest',
      networkConfig(),
      {
        workspacePath: '/workspace',
        homePath: '/home/runner',
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
    );

    const client = await manager.start();
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ cmdline: expect.stringContaining('init=/sbin/awf-supervisor') }),
      disks: expect.arrayContaining([
        expect.objectContaining({ id: 'rootfs' }),
        expect.objectContaining({ id: 'workspace' }),
      ]),
      vsock: expect.objectContaining({ cid: 3 }),
      landlock_rules: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('workspace.ext4') }),
      ]),
    }));
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
    expect(workspace.extractAfterStop).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/cloud-hypervisor/guest/workspace.ext4'),
    );
    expect(order).toEqual(['extract']);
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
    const workspace = {
      prepare: jest.fn().mockResolvedValue({
        workspaceImagePath: '/tmp/workspace.ext4',
        rootfsImagePath: '/tmp/rootfs.ext4',
        imageBytes: 1024,
        originalManifest: new Map(),
      }),
      extractAfterStop: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    } as unknown as MicrovmWorkspaceImage;
    const deps = dependencies({
      createVsockClient: jest.fn().mockReturnValue(guestClient),
      createWorkspaceImage: jest.fn().mockReturnValue(workspace),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'ready-guest',
      networkConfig(),
      {
        workspacePath: '/workspace',
        homePath: '/home/runner',
        supervisorBinaryPath: '/opt/supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
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

  it('quiesces and copies back while preserving run directory, images, and network in keep mode', async () => {
    const child = processMock();
    const workspace = {
      prepare: jest.fn().mockResolvedValue({
        workspaceImagePath: '/tmp/prepared-workspace.ext4',
        rootfsImagePath: '/tmp/prepared-rootfs.ext4',
        imageBytes: 1024,
        originalManifest: new Map(),
      }),
      extractAfterStop: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    } as unknown as MicrovmWorkspaceImage;
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createWorkspaceImage: jest.fn().mockReturnValue(workspace),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      {
        workspacePath: '/workspace',
        homePath: '/home/runner',
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
    );
    await manager.start();
    await manager.startInstance();

    await manager.stop({ preserve: true });

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(workspace.extractAfterStop).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(workspace.cleanup).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
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
      allowedEndpoints: [],
      networkInterface: { iface_id: 'eth0', host_dev_name: 'tap' },
    }, {
      workspacePath: '/workspace',
      homePath: '/home/runner',
      supervisorBinaryPath: '/opt/supervisor',
      supervisorSha256: 'a'.repeat(64),
    });
    expect(args).toContain('root=/dev/vda');
    expect(args).toContain('awf.guest-ip=100.64.0.2');
    expect(args).toContain('awf.guest-gateway=100.64.0.1');
    expect(args).toContain('awf.workspace-device=/dev/vdb');
    expect(args).toContain('net.ifnames=0');
    expect(args).not.toContain('pci=off');
    expect(args).not.toContain('8.8.8.8');
  });

  it('retains the workspace and network until process termination is confirmed', async () => {
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
    const workspace = {
      prepare: jest.fn().mockResolvedValue({
        workspaceImagePath: '/tmp/prepared-workspace.ext4',
        rootfsImagePath: '/tmp/prepared-rootfs.ext4',
        imageBytes: 1024,
        originalManifest: new Map(),
      }),
      extractAfterStop: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    } as unknown as MicrovmWorkspaceImage;
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createWorkspaceImage: jest.fn().mockReturnValue(workspace),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'termination',
      networkConfig(),
      {
        workspacePath: '/workspace',
        homePath: '/home/runner',
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
    );
    await manager.start();
    await manager.startInstance();

    await expect(manager.stop()).rejects.toThrow(/stopped before workspace\/network removal/);
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(workspace.extractAfterStop).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();

    Object.assign(child, { exitCode: 0 });
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(workspace.extractAfterStop).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
  });

  it('waits briefly for natural VM exit after guest shutdown before sending SIGTERM', async () => {
    const child = processMock();
    const workspace = {
      prepare: jest.fn().mockResolvedValue({
        workspaceImagePath: '/tmp/prepared-workspace.ext4',
        rootfsImagePath: '/tmp/prepared-rootfs.ext4',
        imageBytes: 1024,
        originalManifest: new Map(),
      }),
      extractAfterStop: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    } as unknown as MicrovmWorkspaceImage;
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    let sleepCalls = 0;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createWorkspaceImage: jest.fn().mockReturnValue(workspace),
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
      {
        workspacePath: '/workspace',
        homePath: '/home/runner',
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
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
});
