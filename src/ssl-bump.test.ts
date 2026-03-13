import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import execa from 'execa';
import { parseUrlPatterns, generateSessionCa, initSslDb, isOpenSslAvailable, secureWipeFile, cleanupSslKeyMaterial, chownRecursive, unmountSslTmpfs } from './ssl-bump';

// Pattern constant for the safer URL character class (matches the implementation)
const URL_CHAR_PATTERN = '[^\\s]*';

// Mock execa for testing OpenSSL operations
jest.mock('execa');

// Get the mocked execa after jest.mock hoisting
const mockExeca = execa as unknown as jest.Mock;

// Default mock implementation for execa
beforeEach(() => {
  mockExeca.mockReset();
  mockExeca.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'mount' || cmd === 'umount') {
      // tmpfs mount/unmount - fail gracefully in tests (no root privileges)
      return Promise.reject(new Error('mount not available in test'));
    }
    if (cmd === 'openssl') {
      if (args[0] === 'version') {
        return Promise.resolve({ stdout: 'OpenSSL 3.0.0 7 Sep 2021' });
      }
      if (args[0] === 'req') {
        // Mock certificate generation - create the files
        const keyoutIndex = args.indexOf('-keyout');
        const outIndex = args.indexOf('-out');
        if (keyoutIndex !== -1 && outIndex !== -1) {
          const keyPath = args[keyoutIndex + 1];
          const certPath = args[outIndex + 1];
          // Create mock files
          fs.writeFileSync(keyPath, 'MOCK PRIVATE KEY');
          fs.writeFileSync(certPath, 'MOCK CERTIFICATE');
        }
        return Promise.resolve({ stdout: '' });
      }
      if (args[0] === 'x509') {
        // Mock DER conversion
        const outIndex = args.indexOf('-out');
        if (outIndex !== -1) {
          const derPath = args[outIndex + 1];
          fs.writeFileSync(derPath, 'MOCK DER CERTIFICATE');
        }
        return Promise.resolve({ stdout: '' });
      }
    }
    return Promise.reject(new Error(`Unknown command: ${cmd}`));
  });
});

describe('SSL Bump', () => {
  describe('parseUrlPatterns', () => {
    it('should escape regex special characters except wildcards', () => {
      const patterns = parseUrlPatterns(['https://github.com/user']);
      expect(patterns).toEqual(['^https://github\\.com/user$']);
    });

    it('should convert * wildcard to safe regex pattern', () => {
      const patterns = parseUrlPatterns(['https://github.com/myorg/*']);
      expect(patterns).toEqual([`^https://github\\.com/myorg/${URL_CHAR_PATTERN}`]);
    });

    it('should handle multiple wildcards', () => {
      const patterns = parseUrlPatterns(['https://api-*.example.com/*']);
      expect(patterns).toEqual([`^https://api-${URL_CHAR_PATTERN}\\.example\\.com/${URL_CHAR_PATTERN}`]);
    });

    it('should remove trailing slash for consistency', () => {
      const patterns = parseUrlPatterns(['https://github.com/']);
      expect(patterns).toEqual(['^https://github\\.com$']);
    });

    it('should handle exact match patterns', () => {
      const patterns = parseUrlPatterns(['https://api.example.com/v1/users']);
      expect(patterns).toEqual(['^https://api\\.example\\.com/v1/users$']);
    });

    it('should handle query parameters', () => {
      const patterns = parseUrlPatterns(['https://api.example.com/v1?key=value']);
      expect(patterns).toEqual(['^https://api\\.example\\.com/v1\\?key=value$']);
    });

    it('should escape dots in domain names', () => {
      const patterns = parseUrlPatterns(['https://sub.domain.example.com/path']);
      expect(patterns).toEqual(['^https://sub\\.domain\\.example\\.com/path$']);
    });

    it('should handle multiple patterns', () => {
      const patterns = parseUrlPatterns([
        'https://github.com/myorg/*',
        'https://api.example.com/v1/*',
      ]);
      expect(patterns).toHaveLength(2);
      expect(patterns[0]).toBe(`^https://github\\.com/myorg/${URL_CHAR_PATTERN}`);
      expect(patterns[1]).toBe(`^https://api\\.example\\.com/v1/${URL_CHAR_PATTERN}`);
    });

    it('should handle empty array', () => {
      const patterns = parseUrlPatterns([]);
      expect(patterns).toEqual([]);
    });

    it('should anchor patterns correctly for exact matches', () => {
      const patterns = parseUrlPatterns(['https://github.com/exact']);
      // Should have both start and end anchors for exact matches
      expect(patterns[0]).toBe('^https://github\\.com/exact$');
    });

    it('should not add end anchor for wildcard patterns', () => {
      const patterns = parseUrlPatterns(['https://github.com/*']);
      // Should only have start anchor for patterns ending with the URL char pattern
      expect(patterns[0]).toBe(`^https://github\\.com/${URL_CHAR_PATTERN}`);
      expect(patterns[0]).not.toContain('$');
    });
  });

  describe('generateSessionCa', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-bump-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should create ssl directory and CA files', async () => {
      const result = await generateSessionCa({ workDir: tempDir });

      // Check paths are returned
      expect(result.certPath).toBe(path.join(tempDir, 'ssl', 'ca-cert.pem'));
      expect(result.keyPath).toBe(path.join(tempDir, 'ssl', 'ca-key.pem'));
      expect(result.derPath).toBe(path.join(tempDir, 'ssl', 'ca-cert.der'));

      // Check files were created (via mocks)
      expect(fs.existsSync(result.certPath)).toBe(true);
      expect(fs.existsSync(result.keyPath)).toBe(true);
      expect(fs.existsSync(result.derPath)).toBe(true);
    });

    it('should use custom common name and validity days', async () => {
      const result = await generateSessionCa({
        workDir: tempDir,
        commonName: 'Custom CA',
        validityDays: 7,
      });

      // Just verify it completes without error
      expect(result.certPath).toContain('ca-cert.pem');
    });

    it('should create ssl directory if it does not exist', async () => {
      const sslDir = path.join(tempDir, 'ssl');
      expect(fs.existsSync(sslDir)).toBe(false);

      await generateSessionCa({ workDir: tempDir });

      expect(fs.existsSync(sslDir)).toBe(true);
    });

    it('should handle existing ssl directory', async () => {
      const sslDir = path.join(tempDir, 'ssl');
      fs.mkdirSync(sslDir, { recursive: true });

      const result = await generateSessionCa({ workDir: tempDir });

      expect(result.certPath).toContain('ca-cert.pem');
    });

    it('should throw error when OpenSSL command fails', async () => {
      mockExeca.mockImplementation((cmd: string) => {
        if (cmd === 'mount') {
          return Promise.reject(new Error('mount not available'));
        }
        return Promise.reject(new Error('OpenSSL not found'));
      });

      await expect(generateSessionCa({ workDir: tempDir })).rejects.toThrow(
        'Failed to generate SSL Bump CA: OpenSSL not found'
      );
    });

    it('should attempt tmpfs mount for ssl directory', async () => {
      await generateSessionCa({ workDir: tempDir });

      // Verify mount was attempted
      expect(mockExeca).toHaveBeenCalledWith(
        'mount',
        expect.arrayContaining(['-t', 'tmpfs', 'tmpfs']),
      );
    });

    it('should handle non-Error throw from OpenSSL command', async () => {
      mockExeca.mockImplementation((cmd: string) => {
        if (cmd === 'mount') {
          return Promise.reject(new Error('mount not available'));
        }
        // Reject with a string instead of an Error object
        return Promise.reject('unexpected string rejection');
      });

      await expect(generateSessionCa({ workDir: tempDir })).rejects.toThrow(
        'Failed to generate SSL Bump CA: unexpected string rejection'
      );
    });
  });

  describe('initSslDb', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-db-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should create ssl_db directory structure', async () => {
      const sslDbPath = await initSslDb(tempDir);

      expect(sslDbPath).toBe(path.join(tempDir, 'ssl_db'));
      expect(fs.existsSync(path.join(sslDbPath, 'certs'))).toBe(true);
      expect(fs.existsSync(path.join(sslDbPath, 'index.txt'))).toBe(true);
      expect(fs.existsSync(path.join(sslDbPath, 'size'))).toBe(true);
    });

    it('should create empty index.txt file', async () => {
      const sslDbPath = await initSslDb(tempDir);

      const indexContent = fs.readFileSync(path.join(sslDbPath, 'index.txt'), 'utf-8');
      expect(indexContent).toBe('');
    });

    it('should create size file with 0', async () => {
      const sslDbPath = await initSslDb(tempDir);

      const sizeContent = fs.readFileSync(path.join(sslDbPath, 'size'), 'utf-8');
      expect(sizeContent).toBe('0\n');
    });

    it('should not overwrite existing files', async () => {
      // First initialization
      const sslDbPath = await initSslDb(tempDir);

      // Write custom content
      fs.writeFileSync(path.join(sslDbPath, 'index.txt'), 'custom content');

      // Second initialization
      await initSslDb(tempDir);

      // Check content is preserved
      const indexContent = fs.readFileSync(path.join(sslDbPath, 'index.txt'), 'utf-8');
      expect(indexContent).toBe('custom content');
    });

    it('should handle existing ssl_db directory', async () => {
      const sslDbPath = path.join(tempDir, 'ssl_db');
      fs.mkdirSync(sslDbPath, { recursive: true });

      const result = await initSslDb(tempDir);

      expect(result).toBe(sslDbPath);
    });

    it('should silently catch EEXIST when index.txt already exists', async () => {
      // Pre-create the directory structure and files
      const sslDbPath = path.join(tempDir, 'ssl_db');
      fs.mkdirSync(path.join(sslDbPath, 'certs'), { recursive: true });
      fs.writeFileSync(path.join(sslDbPath, 'index.txt'), 'existing');
      fs.writeFileSync(path.join(sslDbPath, 'size'), '42\n');

      // Should not throw — EEXIST is silently caught by the 'wx' flag handler
      const result = await initSslDb(tempDir);
      expect(result).toBe(sslDbPath);

      // Verify existing content was preserved (not overwritten)
      expect(fs.readFileSync(path.join(sslDbPath, 'index.txt'), 'utf-8')).toBe('existing');
      expect(fs.readFileSync(path.join(sslDbPath, 'size'), 'utf-8')).toBe('42\n');
    });

    it('should re-throw non-EEXIST errors from writeFileSync', async () => {
      // Create ssl_db directory, then make it read-only so writeFileSync fails with EACCES
      const sslDbPath = path.join(tempDir, 'ssl_db');
      fs.mkdirSync(path.join(sslDbPath, 'certs'), { recursive: true });
      // Make ssl_db read-only so index.txt creation fails with EACCES
      fs.chmodSync(sslDbPath, 0o555);

      try {
        await expect(initSslDb(tempDir)).rejects.toThrow(/EACCES/);
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(sslDbPath, 0o700);
      }
    });

    it('should re-throw non-EEXIST errors from size file writeFileSync', async () => {
      // Create full structure with index.txt, then make dir read-only
      // so only the size file creation fails
      const sslDbPath = path.join(tempDir, 'ssl_db');
      fs.mkdirSync(path.join(sslDbPath, 'certs'), { recursive: true });
      // Pre-create index.txt so it hits EEXIST (silently caught), then
      // size file creation will fail because dir is read-only
      fs.writeFileSync(path.join(sslDbPath, 'index.txt'), '');
      fs.chmodSync(sslDbPath, 0o555);

      try {
        await expect(initSslDb(tempDir)).rejects.toThrow(/EACCES/);
      } finally {
        fs.chmodSync(sslDbPath, 0o700);
      }
    });

    it('should gracefully handle EPERM from chown (non-root)', async () => {
      // initSslDb calls chownRecursive(sslDbPath, 13, 13) internally.
      // When not running as root, chownSync throws EPERM which is caught.
      // This test verifies the EPERM path completes successfully.
      const result = await initSslDb(tempDir);
      expect(result).toBe(path.join(tempDir, 'ssl_db'));
      // Verify the ssl_db was fully created despite chown failure
      expect(fs.existsSync(path.join(result, 'certs'))).toBe(true);
      expect(fs.existsSync(path.join(result, 'index.txt'))).toBe(true);
      expect(fs.existsSync(path.join(result, 'size'))).toBe(true);
    });

  });

  describe('chownRecursive', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chown-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should attempt to chown a directory and its contents', () => {
      // Create directory structure
      const subDir = path.join(tempDir, 'subdir');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'test');
      fs.writeFileSync(path.join(subDir, 'file2.txt'), 'test');

      // chownRecursive will throw EPERM when not root, but it should
      // attempt to chown the root directory first
      expect(() => chownRecursive(tempDir, 13, 13)).toThrow(/EPERM/);
    });

    it('should throw for non-existent directory', () => {
      expect(() => chownRecursive('/tmp/nonexistent-chown-test', 13, 13)).toThrow();
    });
  });

  describe('isOpenSslAvailable', () => {
    it('should return true when OpenSSL is available', async () => {
      const result = await isOpenSslAvailable();
      expect(result).toBe(true);
    });

    it('should return false when OpenSSL command fails', async () => {
      mockExeca.mockImplementationOnce(() => {
        return Promise.reject(new Error('command not found'));
      });

      const result = await isOpenSslAvailable();
      expect(result).toBe(false);
    });
  });

  describe('secureWipeFile', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should overwrite and delete a file', () => {
      const filePath = path.join(tempDir, 'secret.key');
      fs.writeFileSync(filePath, 'SECRET KEY DATA');

      secureWipeFile(filePath);

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should handle non-existent files gracefully', () => {
      const filePath = path.join(tempDir, 'nonexistent.key');
      expect(() => secureWipeFile(filePath)).not.toThrow();
    });

    it('should handle empty files', () => {
      const filePath = path.join(tempDir, 'empty.key');
      fs.writeFileSync(filePath, '');

      secureWipeFile(filePath);

      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('cleanupSslKeyMaterial', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-cleanup-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should wipe all SSL files', () => {
      const sslDir = path.join(tempDir, 'ssl');
      fs.mkdirSync(sslDir, { mode: 0o700 });
      fs.writeFileSync(path.join(sslDir, 'ca-key.pem'), 'PRIVATE KEY');
      fs.writeFileSync(path.join(sslDir, 'ca-cert.pem'), 'CERTIFICATE');
      fs.writeFileSync(path.join(sslDir, 'ca-cert.der'), 'DER CERT');

      cleanupSslKeyMaterial(tempDir);

      expect(fs.existsSync(path.join(sslDir, 'ca-key.pem'))).toBe(false);
      expect(fs.existsSync(path.join(sslDir, 'ca-cert.pem'))).toBe(false);
      expect(fs.existsSync(path.join(sslDir, 'ca-cert.der'))).toBe(false);
    });

    it('should wipe ssl_db certificate files', () => {
      const sslDir = path.join(tempDir, 'ssl');
      fs.mkdirSync(sslDir, { mode: 0o700 });
      fs.writeFileSync(path.join(sslDir, 'ca-key.pem'), 'KEY');

      const sslDbDir = path.join(tempDir, 'ssl_db');
      const certsDir = path.join(sslDbDir, 'certs');
      fs.mkdirSync(certsDir, { recursive: true });
      fs.writeFileSync(path.join(certsDir, 'cert1.pem'), 'CERT1');
      fs.writeFileSync(path.join(certsDir, 'cert2.pem'), 'CERT2');

      cleanupSslKeyMaterial(tempDir);

      expect(fs.existsSync(path.join(certsDir, 'cert1.pem'))).toBe(false);
      expect(fs.existsSync(path.join(certsDir, 'cert2.pem'))).toBe(false);
    });

    it('should handle missing ssl directory gracefully', () => {
      expect(() => cleanupSslKeyMaterial(tempDir)).not.toThrow();
    });
  });

  describe('unmountSslTmpfs', () => {
    it('should call umount on the ssl directory', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '' });
      await unmountSslTmpfs('/tmp/test-ssl');
      expect(mockExeca).toHaveBeenCalledWith('umount', ['/tmp/test-ssl']);
    });

    it('should handle umount failure gracefully', async () => {
      mockExeca.mockRejectedValueOnce(new Error('not mounted'));
      await expect(unmountSslTmpfs('/tmp/test-ssl')).resolves.not.toThrow();
    });
  });
});
