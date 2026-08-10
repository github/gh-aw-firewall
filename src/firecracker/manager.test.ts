import type { ExecaChildProcess } from 'execa';
import { PassThrough } from 'stream';
import type {
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
} from '../microvm/network';
import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type { MicrovmWorkspaceImage } from '../microvm/workspace';
import type { FirecrackerOptions } from '../types/runtime-options';
import type { FirecrackerApiClient } from './api-client';
import {
  FirecrackerManager,
  buildSupervisorBootArgs,
  createFirecrackerRunPaths,
  firecrackerManagerTestHelpers,
  type FirecrackerManagerDependencies,
  type FirecrackerManagerNetworkConfig,
} from './manager';
import type { FirecrackerHostToolPaths } from './preflight';

const hostTools: FirecrackerHostToolPaths = {
  ip: '/usr/bin/ip',
  nft: '/usr/sbin/nft',
  sysctl: '/usr/sbin/sysctl',
  mke2fs: '/usr/sbin/mke2fs',
  debugfs: '/usr/sbin/debugfs',
  e2fsck: '/usr/sbin/e2fsck',
  rsync: '/usr/bin/rsync',
};

function config(overrides: Partial<FirecrackerOptions> = {}): FirecrackerOptions {
  return {
    previewEnabled: true,
    firecrackerBinary: '/opt/firecracker',
    jailerBinary: '/opt/jailer',
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
    kill: jest.fn(() => {
      Object.assign(child, { exitCode: 0, killed: true });
      return true;
    }),
  });
  return child;
}

function networkConfig(
  overrides: Partial<FirecrackerManagerNetworkConfig> = {},
): FirecrackerManagerNetworkConfig {
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

function dependencies(
  overrides: Partial<FirecrackerManagerDependencies> = {},
): FirecrackerManagerDependencies {
  const client = {
    putMachineConfig: jest.fn().mockResolvedValue(undefined),
    putBootSource: jest.fn().mockResolvedValue(undefined),
    putDrive: jest.fn().mockResolvedValue(undefined),
    putVsock: jest.fn().mockResolvedValue(undefined),
    putNetworkInterface: jest.fn().mockResolvedValue(undefined),
    putLogger: jest.fn().mockResolvedValue(undefined),
    putMetrics: jest.fn().mockResolvedValue(undefined),
    putAction: jest.fn().mockResolvedValue(undefined),
    instanceStart: jest.fn().mockResolvedValue(undefined),
  } as unknown as FirecrackerApiClient;
  return {
    preflight: jest.fn().mockResolvedValue({
      version: '1.16.1',
      firecrackerBinary: '/opt/firecracker',
      jailerBinary: '/opt/jailer',
      kernelPath: '/opt/vmlinux',
      rootfsPath: '/opt/rootfs.ext4',
      tools: hostTools,
      supervisorPath: '/opt/awf-supervisor',
      cgroupVersion: 2,
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
    resolveIdentity: jest.fn().mockReturnValue({ uid: 1000, gid: 1000 }),
    ...overrides,
  };
}

describe('FirecrackerManager', () => {
  it('constructs the default host adapters and jailer identity', async () => {
    const defaults = firecrackerManagerTestHelpers.defaultDependencies;
    const child = defaults.launch(process.execPath, ['-e', ''], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    await expect(child).resolves.toMatchObject({ exitCode: 0 });
    await expect(defaults.sleep(0)).resolves.toBeUndefined();
    expect(defaults.createClient('/tmp/firecracker.socket', 100)).toBeDefined();
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

    const originalSudoUid = process.env.SUDO_UID;
    const originalSudoGid = process.env.SUDO_GID;
    const uidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
    const gidSpy = jest.spyOn(process, 'getgid').mockReturnValue(0);
    try {
      process.env.SUDO_UID = '2001';
      process.env.SUDO_GID = '2002';
      expect(firecrackerManagerTestHelpers.resolveJailerIdentity()).toEqual({
        uid: 2001,
        gid: 2002,
      });

      delete process.env.SUDO_UID;
      delete process.env.SUDO_GID;
      expect(firecrackerManagerTestHelpers.resolveJailerIdentity)
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

  it('constructs unique, contained jail paths', () => {
    const first = createFirecrackerRunPaths('/tmp/awf', '/opt/firecracker');
    const second = createFirecrackerRunPaths('/tmp/awf', '/opt/firecracker');
    expect(first.runId).not.toBe(second.runId);
    expect(first.jailRoot).toContain('/tmp/awf/firecracker-jailer/firecracker/');
    expect(() => createFirecrackerRunPaths(
      '/tmp/awf',
      '/opt/firecracker',
      '../escape',
    )).toThrow(/Unsafe microVM run id/);
    expect(() => createFirecrackerRunPaths(
      '/tmp/awf',
      '/opt/firecracker',
      'run_1',
    )).toThrow(/Unsafe microVM run id/);
    expect(() => createFirecrackerRunPaths(
      '/tmp/awf',
      '/opt/firecracker',
      `run-${'a'.repeat(61)}`,
    )).toThrow(/Unsafe microVM run id/);
  });

  it('launches jailer and configures machine, kernel, and root drive', async () => {
    const deps = dependencies();
    const manager = new FirecrackerManager(
      config(),
      '/tmp/awf',
      deps,
      'run-1',
      networkConfig(),
    );
    const client = await manager.start();

    expect(deps.launch).toHaveBeenCalledWith(
      '/opt/jailer',
      expect.arrayContaining([
        '--id', 'run-1',
        '--exec-file', '/opt/firecracker',
        '--netns', expect.stringMatching(/^\/var\/run\/netns\/awffc-/),
        '--api-sock', '/run/firecracker.socket',
      ]),
      expect.objectContaining({ reject: false }),
    );
    expect(client.putMachineConfig).toHaveBeenCalledWith({
      vcpu_count: 2,
      mem_size_mib: 512,
    });
    expect(client.putBootSource).toHaveBeenCalledWith({
      kernel_image_path: '/kernel',
    });
    expect(client.putDrive).toHaveBeenCalledWith(expect.objectContaining({
      drive_id: 'rootfs',
      path_on_host: '/rootfs',
      is_root_device: true,
    }));
    expect(client.putNetworkInterface).toHaveBeenCalledWith({
      iface_id: 'eth0',
      host_dev_name: expect.stringMatching(/^fct[0-9a-f]{12}$/),
      guest_mac: expect.any(String),
    });
    const configuredNetwork = (client.putNetworkInterface as jest.Mock)
      .mock.calls[0][0] as { guest_mac: string };
    expect(configuredNetwork.guest_mac.split(':')).toHaveLength(6);
    expect(configuredNetwork.guest_mac.startsWith('02:')).toBe(true);
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

  it('terminates the partial process and removes its jail on readiness failure', async () => {
    const child = processMock();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn(async () => new Promise((resolve) => setTimeout(resolve, 2))),
    });
    const manager = new FirecrackerManager(
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
      '/tmp/awf/firecracker-jailer/firecracker/partial',
      { recursive: true, force: true },
    );
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses to launch without host-side network enforcement', async () => {
    const deps = dependencies();
    const manager = new FirecrackerManager(config(), '/tmp/awf', deps, 'unsafe');

    await expect(manager.start()).rejects.toThrow(/unfiltered microVM/);
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('cleans up the network before removing the jail', async () => {
    const order: string[] = [];
    const deps = dependencies({
      createNetwork: jest.fn((plan) => ({
        plan,
        setup: jest.fn().mockResolvedValue(plan),
        cleanup: jest.fn(async () => {
          order.push('network');
        }),
      })),
      rm: jest.fn(async () => {
        order.push('jail');
      }),
    });
    const manager = new FirecrackerManager(
      config(),
      '/tmp/awf',
      deps,
      'cleanup',
      networkConfig(),
    );

    await manager.start();
    await manager.stop();

    expect(order).toEqual(['network', 'jail']);
  });

  it('retains failed network cleanup for a later stop retry', async () => {
    const cleanup = jest.fn()
      .mockRejectedValueOnce(new Error('network cleanup failed'))
      .mockResolvedValue(undefined);
    const deps = dependencies({
      createNetwork: jest.fn((plan) => ({
        plan,
        setup: jest.fn().mockResolvedValue(plan),
        cleanup,
      })),
    });
    const manager = new FirecrackerManager(
      config(),
      '/tmp/awf',
      deps,
      'cleanup-retry',
      networkConfig(),
    );

    await manager.start();
    await expect(manager.stop()).rejects.toThrow('network cleanup failed');
    await expect(manager.stop()).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('configures the workspace drive and vsock, then extracts only after VM termination', async () => {
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
      const manager = new FirecrackerManager(
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
      expect(client.putBootSource).toHaveBeenCalledWith(expect.objectContaining({
        kernel_image_path: '/kernel',
        boot_args: expect.stringContaining('init=/sbin/awf-supervisor'),
      }));
      expect(client.putDrive).toHaveBeenCalledWith({
        drive_id: 'workspace',
        path_on_host: '/workspace.ext4',
        is_root_device: false,
        is_read_only: false,
      });
      expect(client.putVsock).toHaveBeenCalledWith({
        guest_cid: 3,
        uds_path: '/run/awf-vsock.socket',
      });
      await manager.startInstance();
      expect(deps.createVsockClient).toHaveBeenCalledWith(
        '/tmp/awf/firecracker-jailer/firecracker/guest/root/run/awf-vsock.socket',
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
      expect(workspace.extractAfterStop).toHaveBeenCalledWith(
        '/tmp/awf/firecracker-jailer/firecracker/guest/root/workspace.ext4',
      );
      expect(order).toEqual(['extract']);
  });

  it('delegates guest cancellation, stdin, and resize only after readiness', async () => {
      const cold = new FirecrackerManager(
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
      const manager = new FirecrackerManager(
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

  it('quiesces and copies back while preserving jail, images, and network in keep mode', async () => {
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
      const manager = new FirecrackerManager(
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
  });

  it('builds explicit supervisor boot networking without widening policy', () => {
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
      expect(args).toContain('awf.guest-ip=100.64.0.2');
      expect(args).toContain('awf.guest-gateway=100.64.0.1');
      expect(args).toContain('awf.workspace-device=/dev/vdb');
      expect(args).not.toContain('8.8.8.8');
  });

  it('retains the workspace and network until process termination is confirmed', async () => {
      const child = Promise.resolve({ exitCode: null }) as unknown as ExecaChildProcess<string>;
      Object.assign(child, {
        exitCode: null,
        signalCode: null,
        killed: false,
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
      const manager = new FirecrackerManager(
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
    const manager = new FirecrackerManager(
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

  it('rolls back the network when typed NIC configuration fails', async () => {
    const client = {
      putMachineConfig: jest.fn().mockResolvedValue(undefined),
      putBootSource: jest.fn().mockResolvedValue(undefined),
      putDrive: jest.fn().mockResolvedValue(undefined),
      putLogger: jest.fn().mockResolvedValue(undefined),
      putMetrics: jest.fn().mockResolvedValue(undefined),
      putAction: jest.fn().mockResolvedValue(undefined),
      putNetworkInterface: jest.fn().mockRejectedValue(new Error('invalid NIC')),
    } as unknown as FirecrackerApiClient;
    const deps = dependencies({
      createClient: jest.fn().mockReturnValue(client),
    });
    const manager = new FirecrackerManager(
      config(),
      '/tmp/awf',
      deps,
      'nic-failure',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow('invalid NIC');

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalled();
  });

  it('fails fast when jailer exits by signal before API readiness', async () => {
    const child = processMock();
    Object.assign(child, { signalCode: 'SIGKILL', kill: jest.fn() });
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    const manager = new FirecrackerManager(
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

  it('flushes metrics and bounds diagnostic files before persistence', async () => {
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
    const manager = new FirecrackerManager(
      config(),
      '/tmp/awf',
      deps,
      'diagnostics',
      networkConfig(),
    );

    const client = await manager.start();
    stdout.write(oversized);
    stderr.write('jailer error');
    await manager.startInstance();
    await manager.collectDiagnostics('/tmp/diagnostics');

    expect(client.putAction).toHaveBeenCalledWith('FlushMetrics');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/firecracker.metrics.jsonl',
      expect.objectContaining({ length: 1024 * 1024 }),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/jailer-stdout.log',
      expect.objectContaining({ length: 1024 * 1024 }),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/jailer-stderr.log',
      Buffer.from('jailer error'),
      { mode: 0o600 },
    );
  });
});
