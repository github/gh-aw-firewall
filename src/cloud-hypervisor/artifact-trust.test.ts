import { constants, promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import {
  assertDigest,
  assertTrustedHostTool,
  assertTrustedRegularFile,
  calculateSha256,
  hasCompleteArtifactDigests,
  parsePositiveUid,
  resolveTrustedOperatorUid,
  resolveTrustedHostTool,
} from './artifact-trust';
import { hostPreflightReason } from './host-preflight-progress';

const digest = 'a'.repeat(64);

describe('Cloud Hypervisor artifact trust', () => {
  afterEach(() => {
    delete process.env.SUDO_UID;
    jest.restoreAllMocks();
  });

  it.each([
    { location: 'parent', reason: 'ancestor-symlink', stat: { isSymbolicLink: () => true } },
    { location: 'parent', reason: 'ancestor-writable', stat: { mode: 0o40777 } },
    { location: 'parent', reason: 'ancestor-owner', stat: { uid: 1000 } },
    { location: 'file', reason: 'file-symlink', stat: { isSymbolicLink: () => true } },
    { location: 'file', reason: 'file-type', stat: { isFile: () => false } },
    { location: 'file', reason: 'file-writable', stat: { mode: 0o100777 } },
    { location: 'file', reason: 'file-owner', stat: { uid: 1000 } },
  ])('classifies the actual trusted executable $location rejection as $reason', async ({ location, reason, stat }) => {
    jest.spyOn(fs, 'lstat').mockImplementation(async (file) => ({
      uid: 0, mode: 0o100755, isFile: () => true, isSymbolicLink: () => false,
      ...(file === (location === 'parent' ? '/runner' : '/runner/node') ? stat : {}),
    } as Awaited<ReturnType<typeof fs.lstat>>));
    const access = jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    const error = await assertTrustedHostTool('node', '/runner/node').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(hostPreflightReason(error)).toBe(reason);
    expect(access).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'ENOEXEC', 'EIO'])(
    'preserves trusted executable access errno %s without parsing paths or messages', async (code) => {
      jest.spyOn(fs, 'lstat').mockResolvedValue({
        uid: 0, mode: 0o100755, isFile: () => true, isSymbolicLink: () => false,
      } as Awaited<ReturnType<typeof fs.lstat>>);
      const error = Object.assign(new Error('/private/SECRET\nBearer token'), { code });
      jest.spyOn(fs, 'access').mockRejectedValue(error);
      await expect(assertTrustedHostTool('mount', '/trusted/mount')).rejects.toBe(error);
      expect(hostPreflightReason(error)).toBe(code);
    },
  );

  it('searches preserved PATH without accepting symlinks or operator-owned tools and preserves the first rejection', async () => {
    jest.spyOn(fs, 'lstat').mockImplementation(async (file) => {
      if (String(file).startsWith('/missing')) throw Object.assign(new Error('/private/missing'), { code: 'ENOENT' });
      return {
        uid: String(file).startsWith('/runner') ? 1000 : 0, mode: 0o100755,
        isFile: () => true, isSymbolicLink: () => false,
      } as Awaited<ReturnType<typeof fs.lstat>>;
    });
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    await expect(resolveTrustedHostTool('node', { PATH: '/runner/bin:/missing:/trusted' }))
      .resolves.toBe('/trusted/node');
    const error = await resolveTrustedHostTool('node', { PATH: '/runner/bin:/missing' })
      .catch((failure: unknown) => failure);
    expect(hostPreflightReason(error)).toBe('ancestor-owner');
    const missing = await resolveTrustedHostTool('mount', { PATH: '/missing' })
      .catch((failure: unknown) => failure);
    expect(hostPreflightReason(missing)).toBe('tool-not-found');
    const empty = await resolveTrustedHostTool('mount', { PATH: '' }).catch((failure: unknown) => failure);
    expect(hostPreflightReason(empty)).toBe('tool-not-found');
  });

  it('calculates SHA-256 digests for trusted artifacts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-ch-trust-digest-'));
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

  it('accepts root or operator-owned non-writable regular files on trusted ancestor paths', async () => {
    const lstat = jest.fn().mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100755,
      size: 1,
      uid: 1000,
    });
    const access = jest.fn().mockResolvedValue(undefined);

    await expect(assertTrustedRegularFile(
      'Cloud Hypervisor binary',
      '/opt/cloud-hypervisor',
      constants.R_OK | constants.X_OK,
      { uid: 1000, access, lstat, sha256: jest.fn() },
    )).resolves.toBeUndefined();
    expect(access).toHaveBeenCalledWith('/opt/cloud-hypervisor', constants.R_OK | constants.X_OK);
  });

  it('rejects unsafe artifact files, ancestors, and digest mismatches', async () => {
    await expect(assertTrustedRegularFile(
      'Cloud Hypervisor binary',
      'relative/cloud-hypervisor',
      constants.R_OK,
      { uid: 1000, access: jest.fn(), lstat: jest.fn(), sha256: jest.fn() },
    )).rejects.toThrow(/path must be absolute/);

    await expect(assertTrustedRegularFile(
      'Cloud Hypervisor binary',
      '/opt/cloud-hypervisor',
      constants.R_OK,
      {
        uid: 1000,
        access: jest.fn(),
        lstat: jest.fn(async (filePath: string) => ({
          isFile: () => filePath !== '/opt',
          isSymbolicLink: () => false,
          mode: filePath === '/opt' ? 0o040777 : 0o100755,
          size: 1,
          uid: 0,
        })),
        sha256: jest.fn(),
      },
    )).rejects.toThrow(/parent directory must not be group- or world-writable/);

    await expect(assertDigest(
      'Cloud Hypervisor binary',
      '/snapshot/cloud-hypervisor',
      digest,
      {
        uid: 1000,
        access: jest.fn(),
        lstat: jest.fn().mockResolvedValue({ size: 1 }),
        sha256: jest.fn().mockResolvedValue('b'.repeat(64)),
      },
    )).rejects.toThrow(/SHA-256 mismatch/);
  });

  it('rejects untrusted host tool paths', async () => {
    await expect(assertTrustedHostTool('ip', 'relative/ip'))
      .rejects.toThrow(/host tool "ip" path must be absolute/);

    jest.spyOn(fs, 'lstat').mockResolvedValueOnce({
      isFile: () => false,
      isSymbolicLink: () => false,
      mode: 0o040777,
      uid: 0,
    } as never);
    await expect(assertTrustedHostTool('ip', '/trusted/ip'))
      .rejects.toThrow(/host tool "ip" has an untrusted parent directory/);

    jest.restoreAllMocks();
    jest.spyOn(fs, 'lstat')
      .mockResolvedValueOnce({
        isFile: () => false,
        isSymbolicLink: () => false,
        mode: 0o040755,
        uid: 0,
      } as never)
      .mockResolvedValueOnce({
        isFile: () => true,
        isSymbolicLink: () => false,
        mode: 0o100755,
        uid: 1000,
      } as never);
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    await expect(assertTrustedHostTool('ip', '/trusted/ip'))
      .rejects.toThrow(/must be a root-owned non-writable regular file/);
  });

  it('recognizes complete artifact digest sets and sudo operator uids', () => {
    expect(hasCompleteArtifactDigests({
      cloudHypervisor: digest,
      virtiofsd: digest,
      kernel: digest,
      rootfs: digest,
      supervisor: digest,
    })).toBe(true);
    expect(hasCompleteArtifactDigests({ cloudHypervisor: digest })).toBe(false);
    expect(parsePositiveUid('2001')).toBe(2001);
    expect(parsePositiveUid('0')).toBeUndefined();
    process.env.SUDO_UID = '2001';
    expect(resolveTrustedOperatorUid()).toBe(2001);
  });
});
