import type { ExecaChildProcess } from 'execa';
import type { FirecrackerOptions } from '../types/runtime-options';
import type { FirecrackerApiClient } from './api-client';
import {
  FirecrackerManager,
  createFirecrackerRunPaths,
  type FirecrackerManagerDependencies,
  type FirecrackerManagerNetworkConfig,
} from './manager';
import type {
  FirecrackerNetworkLifecycle,
  FirecrackerNetworkPlan,
} from './network';

function config(overrides: Partial<FirecrackerOptions> = {}): FirecrackerOptions {
  return {
    previewEnabled: true,
    firecrackerBinary: '/opt/firecracker',
    jailerBinary: '/opt/jailer',
    kernelPath: '/opt/vmlinux',
    rootfsPath: '/opt/rootfs.ext4',
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

function networkLifecycle(plan: FirecrackerNetworkPlan): FirecrackerNetworkLifecycle {
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
    putNetworkInterface: jest.fn().mockResolvedValue(undefined),
    instanceStart: jest.fn().mockResolvedValue(undefined),
  } as unknown as FirecrackerApiClient;
  return {
    preflight: jest.fn().mockResolvedValue({
      version: '1.16.1',
      firecrackerBinary: '/opt/firecracker',
      jailerBinary: '/opt/jailer',
      kernelPath: '/opt/vmlinux',
      rootfsPath: '/opt/rootfs.ext4',
    }),
    launch: jest.fn().mockReturnValue(processMock()),
    mkdir: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    chown: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
    createClient: jest.fn().mockReturnValue(client),
    createNetwork: jest.fn((plan) => networkLifecycle(plan)),
    resolveIdentity: jest.fn().mockReturnValue({ uid: 1000, gid: 1000 }),
    ...overrides,
  };
}

describe('FirecrackerManager', () => {
  it('constructs unique, contained jail paths', () => {
    const first = createFirecrackerRunPaths('/tmp/awf', '/opt/firecracker');
    const second = createFirecrackerRunPaths('/tmp/awf', '/opt/firecracker');
    expect(first.runId).not.toBe(second.runId);
    expect(first.jailRoot).toContain('/tmp/awf/firecracker-jailer/firecracker/');
    expect(() => createFirecrackerRunPaths(
      '/tmp/awf',
      '/opt/firecracker',
      '../escape',
    )).toThrow(/Unsafe Firecracker run id/);
    expect(() => createFirecrackerRunPaths(
      '/tmp/awf',
      '/opt/firecracker',
      'run_1',
    )).toThrow(/Unsafe Firecracker run id/);
    expect(() => createFirecrackerRunPaths(
      '/tmp/awf',
      '/opt/firecracker',
      `run-${'a'.repeat(61)}`,
    )).toThrow(/Unsafe Firecracker run id/);
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
    expect(deps.createNetwork).toHaveBeenCalledWith(expect.objectContaining({
      infrastructureBridge: 'awfbr0',
      jailerUid: 1000,
      jailerGid: 1000,
    }));
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as FirecrackerNetworkLifecycle;
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
      .value as FirecrackerNetworkLifecycle;
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

  it('rolls back the network when typed NIC configuration fails', async () => {
    const client = {
      putMachineConfig: jest.fn().mockResolvedValue(undefined),
      putBootSource: jest.fn().mockResolvedValue(undefined),
      putDrive: jest.fn().mockResolvedValue(undefined),
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
      .value as FirecrackerNetworkLifecycle;
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
    const manager = new FirecrackerManager(config({ apiTimeoutMs: 2000 }), '/tmp/awf', deps, 'signal');

    await expect(manager.start()).rejects.toThrow(
      /exited before API readiness with code null and signal SIGKILL/,
    );
    expect(deps.sleep).not.toHaveBeenCalled();
  });
});
