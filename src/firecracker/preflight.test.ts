import { constants } from 'fs';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FirecrackerOptions } from '../types/runtime-options';
import {
  calculateSha256,
  firecrackerPreflightTestHelpers,
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
    assertToolAvailable: jest.fn(async (tool: string) => `/usr/bin/${tool}`),
    ...overrides,
  };
}

describe('Firecracker preflight', () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    delete process.env.SUDO_UID;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('runs default version, tool, and digest host probes', async () => {
    const defaults = firecrackerPreflightTestHelpers.defaultDependencies;
    await expect(defaults.runVersion(process.execPath)).resolves.toContain(
      process.version.slice(1),
    );
    await expect(defaults.runVersion('/bin/false')).rejects.toThrow(
      /--version" exited with code/,
    );

    process.env.PATH = `${path.delimiter}/usr/bin`;
    await expect(defaults.assertToolAvailable('false'))
      .resolves.toBe('/usr/bin/false');
    await expect(defaults.assertToolAvailable('definitely-not-an-awf-tool'))
      .rejects.toThrow(/was not found on PATH/);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-preflight-digest-'));
    const target = path.join(directory, 'artifact');
    try {
      await fs.writeFile(target, 'verified artifact');
      await expect(calculateSha256(target)).resolves.toBe(
        createHash('sha256').update('verified artifact').digest('hex'),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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
    expect(deps.assertToolAvailable).toHaveBeenCalledTimes(7);
    expect(result.tools).toEqual({
      ip: '/usr/bin/ip',
      nft: '/usr/bin/nft',
      sysctl: '/usr/bin/sysctl',
      mke2fs: '/usr/bin/mke2fs',
      debugfs: '/usr/bin/debugfs',
      e2fsck: '/usr/bin/e2fsck',
      rsync: '/usr/bin/rsync',
    });
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

    await expect(runFirecrackerPreflight(
      config({ sha256: { kernel: 'bad' } }),
      dependencies(),
    )).rejects.toThrow(/must contain exactly 64 hexadecimal/);
  });

  it('rejects missing artifacts, unsupported hosts, and unavailable tools', async () => {
    await expect(runFirecrackerPreflight(
      config({ supervisorPath: undefined }),
      dependencies(),
    )).rejects.toThrow(/requires guest kernel, rootfs, and supervisor/);
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ platform: 'darwin' }),
    )).rejects.toThrow(/requires Linux with KVM/);
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({ arch: 'ia32' }),
    )).rejects.toThrow(/supports only x86_64 and aarch64/);
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({
        assertToolAvailable: jest.fn().mockRejectedValue('missing'),
      }),
    )).rejects.toThrow(/requires host tool "ip": missing/);
  });

  it('rejects untrusted artifact files and inaccessible paths', async () => {
    await expect(runFirecrackerPreflight(
      config({ firecrackerBinary: 'relative/firecracker' }),
      dependencies(),
    )).rejects.toThrow(/path must be absolute/);
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({
        lstat: jest.fn(async (filePath: string) => (
          filePath === '/opt/firecracker'
            ? {
                isFile: () => false,
                isSymbolicLink: () => true,
                mode: 0o120777,
                uid: 0,
              }
            : {
                isFile: () => false,
                isSymbolicLink: () => false,
                mode: 0o040755,
                uid: 0,
              }
        )),
      }),
    )).rejects.toThrow(/regular file and not a symbolic link/);
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({
        lstat: jest.fn().mockResolvedValue({
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100755,
          uid: 4000,
        }),
      }),
    )).rejects.toThrow(/must be owned by root or uid/);
    await expect(runFirecrackerPreflight(
      config(),
      dependencies({
        access: jest.fn(async (filePath: string) => {
          if (filePath !== '/dev/kvm') throw new Error('EACCES');
        }),
      }),
    )).rejects.toThrow(/does not have the required host access/);
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

  it('rejects user-controlled PATH tools', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-preflight-tool-'));
    const tool = path.join(directory, 'ip');
    await fs.writeFile(tool, '#!/bin/sh\n');
    await fs.chmod(tool, 0o755);
    process.env.PATH = directory;
    try {
      await expect(firecrackerPreflightTestHelpers.defaultDependencies.assertToolAvailable('ip'))
        .rejects.toThrow(/trusted host tool "ip"/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
