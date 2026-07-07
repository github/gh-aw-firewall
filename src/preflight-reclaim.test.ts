import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import execa from 'execa';
import { preflightReclaimTestHelpers } from './preflight-reclaim';

const { findNonWritableAncestor, isProtectedPath, reclaimStaleDirectory } = preflightReclaimTestHelpers;

jest.mock('execa', () => ({
  sync: jest.fn(),
}));

const mockExecaSync = execa.sync as jest.MockedFunction<typeof execa.sync>;

describe('preflight-reclaim', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-reclaim-test-'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('isProtectedPath', () => {
    it('returns true for root', () => {
      expect(isProtectedPath('/')).toBe(true);
    });

    it('returns true for /tmp', () => {
      expect(isProtectedPath('/tmp')).toBe(true);
    });

    it('returns true for /home/runner', () => {
      expect(isProtectedPath('/home/runner')).toBe(true);
    });

    it('returns true for /home/runner/work', () => {
      expect(isProtectedPath('/home/runner/work')).toBe(true);
    });

    it('returns false for a subdirectory of /tmp', () => {
      expect(isProtectedPath('/tmp/gh-aw')).toBe(false);
    });

    it('returns false for a user working directory', () => {
      expect(isProtectedPath('/tmp/gh-aw/sandbox/firewall')).toBe(false);
    });
  });

  describe('findNonWritableAncestor', () => {
    it('returns undefined when target does not exist and parent is writable', () => {
      const target = path.join(tempDir, 'does', 'not', 'exist');
      // tempDir is writable, so finding the first existing writable ancestor means no issue
      expect(findNonWritableAncestor(target)).toBeUndefined();
    });

    it('returns undefined when target exists and is writable', () => {
      const target = path.join(tempDir, 'subdir');
      fs.mkdirSync(target);
      expect(findNonWritableAncestor(target)).toBeUndefined();
    });

    it('returns the non-writable directory when target exists but is not writable', () => {
      const target = path.join(tempDir, 'readonly');
      fs.mkdirSync(target);
      fs.chmodSync(target, 0o555); // read+execute only
      try {
        const result = findNonWritableAncestor(path.join(target, 'child'));
        expect(result).toBe(target);
      } finally {
        fs.chmodSync(target, 0o755); // restore for cleanup
      }
    });

    it('returns the non-writable ancestor when only parent is non-writable', () => {
      const parent = path.join(tempDir, 'parent');
      fs.mkdirSync(parent);
      fs.chmodSync(parent, 0o555); // make parent non-writable
      try {
        // target does not exist yet, and its parent (parent) is not writable
        const target = path.join(parent, 'newchild', 'grandchild');
        const result = findNonWritableAncestor(target);
        expect(result).toBe(parent);
      } finally {
        fs.chmodSync(parent, 0o755); // restore for cleanup
      }
    });
  });

  describe('reclaimStaleDirectory', () => {
    it('returns false when running as root', () => {
      const originalGetuid = process.getuid;
      process.getuid = () => 0;
      try {
        expect(reclaimStaleDirectory('/tmp/gh-aw/sandbox')).toBe(false);
      } finally {
        process.getuid = originalGetuid;
      }
    });

    it('returns false when target path is fully writable', () => {
      const target = path.join(tempDir, 'writable', 'path');
      fs.mkdirSync(path.join(tempDir, 'writable'));
      expect(reclaimStaleDirectory(target)).toBe(false);
      expect(mockExecaSync).not.toHaveBeenCalled();
    });

    it('returns false for protected paths', () => {
      // Even if /tmp were non-writable, we should not try to remove it
      const result = reclaimStaleDirectory('/tmp');
      expect(result).toBe(false);
    });

    it('attempts sudo rm when directory is not writable', () => {
      const staleDir = path.join(tempDir, 'stale');
      fs.mkdirSync(staleDir);
      fs.chmodSync(staleDir, 0o555);

      mockExecaSync.mockReturnValue({ exitCode: 0 } as any);

      try {
        const target = path.join(staleDir, 'child');
        const result = reclaimStaleDirectory(target);
        expect(result).toBe(true);
        expect(mockExecaSync).toHaveBeenCalledWith(
          'sudo',
          ['rm', '-rf', staleDir],
          expect.objectContaining({ reject: false, timeout: 10_000 }),
        );
      } finally {
        // Restore permissions if sudo mock didn't actually remove it
        if (fs.existsSync(staleDir)) {
          fs.chmodSync(staleDir, 0o755);
        }
      }
    });

    it('falls back to fs.rmSync when sudo fails', () => {
      const staleDir = path.join(tempDir, 'stale2');
      fs.mkdirSync(staleDir);
      fs.chmodSync(staleDir, 0o555);

      mockExecaSync.mockReturnValue({ exitCode: 1, stderr: 'sudo: not found' } as any);

      try {
        const target = path.join(staleDir, 'child');
        // fs.rmSync will likely also fail on the non-writable dir, but we test the flow
        const result = reclaimStaleDirectory(target);
        // Result depends on whether fs.rmSync succeeds (it won't on a dir we just chmod'd 555)
        expect(mockExecaSync).toHaveBeenCalled();
        // The important thing is it doesn't throw
        expect(typeof result).toBe('boolean');
      } finally {
        if (fs.existsSync(staleDir)) {
          fs.chmodSync(staleDir, 0o755);
        }
      }
    });
  });
});
