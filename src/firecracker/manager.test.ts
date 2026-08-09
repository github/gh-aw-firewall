import type { ExecaChildProcess } from 'execa';
import type { FirecrackerOptions } from '../types/runtime-options';
import type { FirecrackerApiClient } from './api-client';
import {
  FirecrackerManager,
  createFirecrackerRunPaths,
  type FirecrackerManagerDependencies,
} from './manager';

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

function dependencies(
  overrides: Partial<FirecrackerManagerDependencies> = {},
): FirecrackerManagerDependencies {
  const client = {
    putMachineConfig: jest.fn().mockResolvedValue(undefined),
    putBootSource: jest.fn().mockResolvedValue(undefined),
    putDrive: jest.fn().mockResolvedValue(undefined),
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
  });

  it('launches jailer and configures machine, kernel, and root drive', async () => {
    const deps = dependencies();
    const manager = new FirecrackerManager(config(), '/tmp/awf', deps, 'run-1');
    const client = await manager.start();

    expect(deps.launch).toHaveBeenCalledWith(
      '/opt/jailer',
      expect.arrayContaining([
        '--id', 'run-1',
        '--exec-file', '/opt/firecracker',
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
  });

  it('terminates the partial process and removes its jail on readiness failure', async () => {
    const child = processMock();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn(async () => new Promise((resolve) => setTimeout(resolve, 2))),
    });
    const manager = new FirecrackerManager(config(), '/tmp/awf', deps, 'partial');

    await expect(manager.start()).rejects.toThrow(/API socket was not ready/);
    expect(child.kill).toHaveBeenCalledWith(
      'SIGTERM',
      { forceKillAfterTimeout: 2_000 },
    );
    expect(deps.rm).toHaveBeenCalledWith(
      '/tmp/awf/firecracker-jailer/firecracker/partial',
      { recursive: true, force: true },
    );
  });
});
