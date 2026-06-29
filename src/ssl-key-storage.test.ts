/**
 * Direct unit tests for ssl-key-storage.ts
 *
 * Covers branches not exercised by ssl-bump.test.ts (which imports via re-exports):
 *   - mountSslTmpfs: success path (return true)
 *   - secureWipeFile: zero-size file, non-regular file, ENOENT on open,
 *     suppressed close error, ENOENT/non-ENOENT on post-wipe unlink
 *   - cleanupSslKeyMaterial: ssl_db directory exists but certs sub-dir absent
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Selectively override low-level file-I/O used by secureWipeFile while keeping
// the higher-level fs helpers (existsSync, mkdirSync, mkdtempSync, rmSync, …)
// real so that cleanupSslKeyMaterial can interact with actual temp directories.
const mockOpenSync = jest.fn<number, unknown[]>();
const mockFstatSync = jest.fn();
const mockWriteSync = jest.fn<number, unknown[]>();
const mockFsyncSync = jest.fn();
const mockCloseSync = jest.fn();
const mockUnlinkSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    openSync: (...args: unknown[]) => mockOpenSync(...args),
    fstatSync: (...args: unknown[]) => mockFstatSync(...args),
    writeSync: (...args: unknown[]) => mockWriteSync(...args),
    fsyncSync: (...args: unknown[]) => mockFsyncSync(...args),
    closeSync: (...args: unknown[]) => mockCloseSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  };
});

import * as os from 'os';
import * as path from 'path';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import {
  mountSslTmpfs,
  secureWipeFile,
  cleanupSslKeyMaterial,
} from './ssl-key-storage';

const FAKE_FD = 42;

describe('ssl-key-storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── mountSslTmpfs ────────────────────────────────────────────────────────

  describe('mountSslTmpfs', () => {
    it('returns true when the mount command succeeds', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const result = await mountSslTmpfs('/tmp/awf-ssl-test');

      expect(result).toBe(true);
      expect(mockExecaFn).toHaveBeenCalledWith('mount', [
        '-t', 'tmpfs',
        '-o', 'size=4m,mode=0700,noexec,nosuid,nodev',
        'tmpfs',
        '/tmp/awf-ssl-test',
      ]);
    });

    it('returns false when the mount command fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('Operation not permitted'));

      const result = await mountSslTmpfs('/tmp/awf-ssl-test');

      expect(result).toBe(false);
    });
  });

  // ─── secureWipeFile ───────────────────────────────────────────────────────

  describe('secureWipeFile', () => {
    beforeEach(() => {
      // Default: openSync succeeds, closeSync succeeds, unlinkSync succeeds.
      mockOpenSync.mockReturnValue(FAKE_FD);
      mockCloseSync.mockImplementation(() => undefined);
      mockUnlinkSync.mockImplementation(() => undefined);
    });

    it('skips the overwrite loop for a zero-size file but still deletes it', () => {
      mockFstatSync.mockReturnValueOnce({ isFile: () => true, size: 0 });

      secureWipeFile('/tmp/empty-key.pem');

      expect(mockWriteSync).not.toHaveBeenCalled();
      expect(mockFsyncSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/empty-key.pem');
    });

    it('does not wipe and gracefully continues when path is not a regular file', () => {
      mockFstatSync.mockReturnValueOnce({ isFile: () => false, size: 100 });

      // Must not throw — error is caught internally and logged.
      expect(() => secureWipeFile('/dev/zero')).not.toThrow();
      expect(mockWriteSync).not.toHaveBeenCalled();
    });

    it('returns early without calling unlink when openSync throws ENOENT', () => {
      const enoentErr = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      mockOpenSync.mockImplementationOnce(() => { throw enoentErr; });

      secureWipeFile('/tmp/gone.pem');

      expect(mockFstatSync).not.toHaveBeenCalled();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('suppresses errors thrown by closeSync in the finally block', () => {
      mockFstatSync.mockReturnValueOnce({ isFile: () => true, size: 0 });
      mockCloseSync.mockImplementationOnce(() => { throw new Error('close failed'); });

      expect(() => secureWipeFile('/tmp/key.pem')).not.toThrow();
      // unlinkSync should still be attempted after the finally block
      expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/key.pem');
    });

    it('returns early without retry when post-wipe unlinkSync throws ENOENT', () => {
      const size = 16;
      mockFstatSync.mockReturnValueOnce({ isFile: () => true, size });
      mockWriteSync.mockReturnValueOnce(size);
      mockFsyncSync.mockImplementation(() => undefined);
      const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockUnlinkSync.mockImplementationOnce(() => { throw enoentErr; });

      expect(() => secureWipeFile('/tmp/wiped-key.pem')).not.toThrow();
      // Only one unlink attempt (no retry for ENOENT).
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('retries unlink and logs when post-wipe unlinkSync throws a non-ENOENT error', () => {
      const size = 8;
      mockFstatSync.mockReturnValueOnce({ isFile: () => true, size });
      mockWriteSync.mockReturnValueOnce(size);
      mockFsyncSync.mockImplementation(() => undefined);
      const epermErr = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      // First call throws EPERM; second (retry) succeeds.
      mockUnlinkSync
        .mockImplementationOnce(() => { throw epermErr; })
        .mockImplementationOnce(() => undefined);

      expect(() => secureWipeFile('/tmp/readonly-key.pem')).not.toThrow();
      expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
    });

    it('logs success after writing and deleting a file with content', () => {
      const size = 32;
      mockFstatSync.mockReturnValueOnce({ isFile: () => true, size });
      mockWriteSync.mockReturnValueOnce(size);
      mockFsyncSync.mockImplementation(() => undefined);

      expect(() => secureWipeFile('/tmp/ca-key.pem')).not.toThrow();
      expect(mockWriteSync).toHaveBeenCalledTimes(1);
      expect(mockFsyncSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/ca-key.pem');
    });
  });

  // ─── cleanupSslKeyMaterial ────────────────────────────────────────────────

  describe('cleanupSslKeyMaterial', () => {
    let tempDir: string;

    beforeEach(() => {
      // Use real fs for directory creation; openSync is mocked to simulate
      // that the individual SSL files inside sslDir do not exist.
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockOpenSync.mockImplementation(() => { throw enoent; });
      mockUnlinkSync.mockImplementation(() => undefined);

      // Create a real temp directory for each test.
      const realFs = jest.requireActual<typeof import('fs')>('fs');
      tempDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ssl-cleanup-test-'));
    });

    afterEach(() => {
      const realFs = jest.requireActual<typeof import('fs')>('fs');
      realFs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('skips the certs loop when ssl_db exists but certs sub-dir does not', () => {
      const realFs = jest.requireActual<typeof import('fs')>('fs');

      // sslDir must exist for cleanupSslKeyMaterial to proceed.
      realFs.mkdirSync(path.join(tempDir, 'ssl'), { recursive: true });
      // ssl_db exists but certs/ inside it does not.
      realFs.mkdirSync(path.join(tempDir, 'ssl_db'), { recursive: true });

      // Should complete without throwing.
      expect(() => cleanupSslKeyMaterial(tempDir)).not.toThrow();

      // secureWipeFile is called for the 3 ssl files (all hit ENOENT and return
      // early), but the certs directory loop must NOT be entered.
      // We confirm this by checking that openSync was only called for the 3 ssl
      // files (ca-key.pem, ca-cert.pem, ca-cert.der) and not for any certs/ file.
      expect(mockOpenSync).toHaveBeenCalledTimes(3);
    });

    it('does not enter the ssl_db block when ssl_db directory does not exist', () => {
      const realFs = jest.requireActual<typeof import('fs')>('fs');
      realFs.mkdirSync(path.join(tempDir, 'ssl'), { recursive: true });
      // ssl_db not created.

      expect(() => cleanupSslKeyMaterial(tempDir)).not.toThrow();
      // Only 3 openSync calls for the ssl files; none for ssl_db.
      expect(mockOpenSync).toHaveBeenCalledTimes(3);
    });
  });
});
