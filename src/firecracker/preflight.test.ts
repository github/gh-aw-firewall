import { constants } from 'fs';
import type { FirecrackerOptions } from '../types/runtime-options';
import {
  parseFirecrackerVersion,
  runFirecrackerPreflight,
  type FirecrackerPreflightDependencies,
} from './preflight';

const digest = 'a'.repeat(64);

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
    apiTimeoutMs: 5000,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<FirecrackerPreflightDependencies> = {},
): Partial<FirecrackerPreflightDependencies> {
  return {
    platform: 'linux',
    arch: 'x64',
    uid: 1000,
    access: jest.fn().mockResolvedValue(undefined),
    lstat: jest.fn().mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100755,
      uid: 0,
    }),
    runVersion: jest.fn().mockResolvedValue('Firecracker v1.16.1'),
    sha256: jest.fn().mockResolvedValue(digest),
    assertToolAvailable: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Firecracker preflight', () => {
  afterEach(() => {
    delete process.env.SUDO_UID;
  });

  it('parses Firecracker and jailer release output', () => {
    expect(parseFirecrackerVersion('Firecracker v1.16.1')).toBe('1.16.1');
    expect(parseFirecrackerVersion('Jailer v1.16.1')).toBe('1.16.1');
    expect(() => parseFirecrackerVersion('unknown')).toThrow(/Could not parse/);
  });

  it('pins matching Firecracker and jailer v1.16.1 and verifies configured digests', async () => {
    const deps = dependencies();
    const result = await runFirecrackerPreflight(config({
      sha256: {
        firecracker: digest,
        jailer: digest,
        kernel: digest,
        rootfs: digest,
        supervisor: digest,
      },
    }), deps);

    expect(result.version).toBe('1.16.1');
    expect(deps.access).toHaveBeenCalledWith(
      '/dev/kvm',
      constants.R_OK | constants.W_OK,
    );
    expect(deps.sha256).toHaveBeenCalledTimes(5);
    expect(deps.assertToolAvailable).toHaveBeenCalledTimes(6);
  });

  it('rejects inaccessible KVM without checking artifacts', async () => {
    const access = jest.fn().mockRejectedValue(new Error('EACCES'));
    const lstat = jest.fn();
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ access, lstat }),
    )).rejects.toThrow(/readable and writable \/dev\/kvm.*EACCES/);
    expect(lstat).not.toHaveBeenCalled();
  });

  it('rejects mismatched versions, unsafe permissions, and digest mismatches', async () => {
    const runVersion = jest.fn()
      .mockResolvedValueOnce('Firecracker v1.16.1')
      .mockResolvedValueOnce('Jailer v1.15.0');
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ runVersion }),
    )).rejects.toThrow(/versions must match/);

    await expect(runFirecrackerPreflight(
      config(),
      dependencies({
        lstat: jest.fn().mockResolvedValue({
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100777,
          uid: 1000,
        }),
      }),
    )).rejects.toThrow(/must not be group- or world-writable/);

    await expect(runFirecrackerPreflight(
      config({ sha256: { kernel: digest } }),
      dependencies({ sha256: jest.fn().mockResolvedValue('b'.repeat(64)) }),
    )).rejects.toThrow(/SHA-256 mismatch/);
  });

  it('uses SUDO_UID as trusted owner when running under sudo', async () => {
    process.env.SUDO_UID = '2001';
    const lstat = jest.fn().mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100755,
      uid: 2001,
    });
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ uid: undefined, lstat }),
    )).resolves.toMatchObject({ version: '1.16.1' });
  });

  it('rejects writable or symlinked parent directories', async () => {
    const lstat = jest.fn(async (filePath: string) => {
      if (filePath === '/opt') {
        return {
          isFile: () => false,
          isSymbolicLink: () => false,
          mode: 0o040777,
          uid: 0,
        };
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o100755,
        uid: 0,
      };
    });
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ lstat }),
    )).rejects.toThrow(/parent directory must not be group- or world-writable/);

    const symlinkParent = jest.fn(async (filePath: string) => {
      if (filePath === '/opt') {
        return {
          isFile: () => false,
          isSymbolicLink: () => true,
          mode: 0o040755,
          uid: 0,
        };
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o100755,
        uid: 0,
      };
    });
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ lstat: symlinkParent }),
    )).rejects.toThrow(/parent directory must not be a symbolic link/);
  });
});
