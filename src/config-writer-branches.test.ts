/**
 * Branch coverage for config-writer.ts paths not reached by config-writer.test.ts:
 *   - writeAuditArtifacts: auditDir symlink guard
 *   - copySeccompProfile: alternate seccomp-profile.json fallback path
 *   - initializeSslBump: non-Error rejection propagation
 */

import './test-helpers/config-writer-dependency-mocks.test-utils';

import * as fs from 'fs';
import * as path from 'path';
import { writeConfigs } from './config-writer';
import { isOpenSslAvailable, generateSessionCa, initSslDb } from './ssl-bump';
import {
  buildWriteConfig,
  setupConfigWriterTempDir,
  cleanupConfigWriterTempDir,
} from './test-helpers/config-writer-test-harness.test-utils';

describe('config-writer additional branches', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupConfigWriterTempDir('cw-branches-test-');
  });

  afterEach(() => {
    cleanupConfigWriterTempDir(tempDir);
  });

  // ─── writeAuditArtifacts symlink guard ─────────────────────────────────

  describe('audit directory symlink guard', () => {
    it('throws when auditDir resolves to a symlink', async () => {
      const realAuditDir = path.join(tempDir, 'real-audit');
      const symlinkAuditDir = path.join(tempDir, 'symlink-audit');
      fs.mkdirSync(realAuditDir, { recursive: true });
      fs.symlinkSync(realAuditDir, symlinkAuditDir);

      await expect(
        writeConfigs(buildWriteConfig(tempDir, { auditDir: symlinkAuditDir }))
      ).rejects.toThrow(`Refusing to use symlink as directory: ${symlinkAuditDir}`);
    });
  });

  // ─── copySeccompProfile alternate path ──────────────────────────────────

  describe('seccomp profile alternate-path fallback', () => {
    it('copies the profile from the dist-relative alt path when the src path is missing', async () => {
      const existsSyncMock = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
      const originalImpl = existsSyncMock.getMockImplementation()!;

      // Intercept only the primary containers/ path so the alt path is tried next.
      existsSyncMock.mockImplementation((filePath: fs.PathLike) => {
        const p = typeof filePath === 'string' ? filePath : filePath.toString();
        // Primary source path ends with containers/agent/seccomp-profile.json.
        // We target the specific segment after src/ (not dist/).
        if (
          p.includes(`src${path.sep}..${path.sep}containers`) ||
          p.includes(`src/../containers`)
        ) {
          return false;
        }
        return originalImpl(filePath);
      });

      try {
        // Should succeed — the alt path resolves via dist/../../containers/...
        // and the real file exists at containers/agent/seccomp-profile.json.
        await expect(writeConfigs(buildWriteConfig(tempDir))).resolves.toBeUndefined();
      } finally {
        existsSyncMock.mockImplementation(originalImpl);
      }
    });
  });

  // ─── initializeSslBump non-Error propagation ───────────────────────────

  describe('SSL Bump initialization with non-Error rejection', () => {
    it('wraps a non-Error thrown by generateSessionCa in an Error', async () => {
      (isOpenSslAvailable as jest.Mock).mockResolvedValue(true);
      (generateSessionCa as jest.Mock).mockRejectedValue('string rejection');

      await expect(
        writeConfigs(buildWriteConfig(tempDir, { sslBump: true }))
      ).rejects.toThrow('SSL Bump initialization failed: string rejection');
    });
  });

  // ─── initializeSslBump success path ────────────────────────────────────

  describe('SSL Bump initialization - success path', () => {
    it('completes SSL Bump setup and calls initSslDb when OpenSSL succeeds', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { logger } = require('./logger') as typeof import('./logger');
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      try {
        const fakeCaFiles = {
          certPath: path.join(tempDir, 'ca.pem'),
          keyPath: path.join(tempDir, 'ca.key'),
          derPath: path.join(tempDir, 'ca.der'),
        };
        (isOpenSslAvailable as jest.Mock).mockResolvedValue(true);
        (generateSessionCa as jest.Mock).mockResolvedValue(fakeCaFiles);
        (initSslDb as jest.Mock).mockResolvedValue(path.join(tempDir, 'ssl-db'));

        await expect(
          writeConfigs(buildWriteConfig(tempDir, { sslBump: true }))
        ).resolves.toBeUndefined();

        expect(initSslDb).toHaveBeenCalledWith(tempDir);

        expect(infoSpy).toHaveBeenCalledWith(
          'SSL Bump enabled - generating per-session CA certificate...'
        );
        expect(infoSpy).toHaveBeenCalledWith(
          'SSL Bump CA certificate generated successfully'
        );
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SSL Bump mode'));
      } finally {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
